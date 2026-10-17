import type {
  CoreV1Event,
  V1Container,
  V1DaemonSet,
  V1Deployment,
  V1Ingress,
  V1Job,
  V1Node,
  V1Pod,
  V1Service,
  V1StatefulSet,
} from '@kubernetes/client-node';
import {
  cpuMilli,
  DASHBOARD_EVENT_LIMIT,
  parseQuantity,
  type Dashboard,
  type DashboardWorkload,
  type ProblemPod,
} from '@capi-navigator/shared';

/** Raw objects read from the workload cluster (FP-18). */
export interface DashboardRaw {
  version?: string;
  nodes: V1Node[];
  pods: V1Pod[];
  namespaces: number;
  deployments: V1Deployment[];
  statefulSets: V1StatefulSet[];
  daemonSets: V1DaemonSet[];
  jobs: V1Job[];
  services: V1Service[];
  ingresses: V1Ingress[];
  /** gateway.networking.k8s.io HTTPRoutes, if the API exists. */
  httpRoutes: HttpRoute[];
  events: CoreV1Event[];
  /** metrics.k8s.io node metrics; undefined without metrics-server. */
  nodeMetrics?: { name: string; cpu: string; memory: string }[];
  warnings: string[];
}

export interface HttpRoute {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    hostnames?: string[];
    parentRefs?: { name?: string }[];
    rules?: { backendRefs?: { name?: string; port?: number }[] }[];
  };
}

const WAITING_PROBLEMS = new Set([
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'CreateContainerConfigError',
  'CreateContainerError',
  'InvalidImageName',
  'RunContainerError',
]);
const RESTART_THRESHOLD = 5;

type Resources = { cpuReq: number; cpuLim: number; memReq: number; memLim: number };

/** Effective pod requests/limits like the scheduler: max(sum of containers, largest init). */
function podResources(pod: V1Pod): Resources {
  const sum = (cs: V1Container[]) =>
    (cs ?? []).reduce(
      (acc, c) => ({
        cpuReq: acc.cpuReq + cpuMilli(c.resources?.requests?.cpu),
        cpuLim: acc.cpuLim + cpuMilli(c.resources?.limits?.cpu),
        memReq: acc.memReq + parseQuantity(c.resources?.requests?.memory),
        memLim: acc.memLim + parseQuantity(c.resources?.limits?.memory),
      }),
      { cpuReq: 0, cpuLim: 0, memReq: 0, memLim: 0 },
    );
  const main = sum(pod.spec?.containers ?? []);
  const init = (pod.spec?.initContainers ?? []).map((c) => sum([c]));
  const max = (k: keyof Resources) => Math.max(main[k], ...init.map((i) => i[k]));
  const overhead = pod.spec?.overhead ?? {};
  return {
    cpuReq: max('cpuReq') + cpuMilli(overhead.cpu),
    cpuLim: max('cpuLim'),
    memReq: max('memReq') + parseQuantity(overhead.memory),
    memLim: max('memLim'),
  };
}

const active = (p: V1Pod) => p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed';

function workloadStatus(desired: number, ready: number): DashboardWorkload['status'] {
  if (ready >= desired) return 'ok';
  return desired > 0 && ready === 0 ? 'degraded' : 'progressing';
}

function problemOf(pod: V1Pod): ProblemPod | undefined {
  const phase = pod.status?.phase ?? 'Unknown';
  if (phase === 'Succeeded') return undefined;
  const statuses = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
  const restarts = statuses.reduce((n, s) => n + (s.restartCount ?? 0), 0);
  const waiting = statuses.find((s) => s.state?.waiting?.reason)?.state?.waiting;
  const terminated = statuses.find((s) => s.state?.terminated?.exitCode)?.state?.terminated;
  let reason: string | undefined;
  let message: string | undefined;
  if (waiting?.reason && WAITING_PROBLEMS.has(waiting.reason)) {
    reason = waiting.reason;
    message = waiting.message;
  } else if (phase === 'Failed') {
    reason = pod.status?.reason ?? terminated?.reason ?? 'Failed';
    message = pod.status?.message ?? terminated?.message;
  } else if (phase === 'Pending') {
    const cond = pod.status?.conditions?.find(
      (c) => c.type === 'PodScheduled' && c.status === 'False',
    );
    reason = cond?.reason ?? waiting?.reason ?? 'Pending';
    message = cond?.message ?? waiting?.message;
  } else if (restarts >= RESTART_THRESHOLD) {
    reason = `${restarts} restarts`;
  }
  if (!reason) return undefined;
  return {
    namespace: pod.metadata?.namespace ?? '',
    name: pod.metadata?.name ?? '',
    ...(pod.spec?.nodeName ? { node: pod.spec.nodeName } : {}),
    phase,
    reason,
    restarts,
    ...(message ? { message: message.slice(0, 300) } : {}),
  };
}

const lbAddresses = (ingress?: { ip?: string; hostname?: string }[]) =>
  (ingress ?? []).flatMap((i) => [i.ip, i.hostname].filter((x): x is string => !!x));

/** Pure mapping of the raw objects to the dashboard (FP-18). */
export function buildDashboard(raw: DashboardRaw, now = new Date()): Dashboard {
  const perNode = new Map<string, Resources & { pods: number }>();
  for (const pod of raw.pods.filter(active)) {
    const node = pod.spec?.nodeName;
    if (!node) continue;
    const r = podResources(pod);
    const cur = perNode.get(node) ?? { cpuReq: 0, cpuLim: 0, memReq: 0, memLim: 0, pods: 0 };
    perNode.set(node, {
      cpuReq: cur.cpuReq + r.cpuReq,
      cpuLim: cur.cpuLim + r.cpuLim,
      memReq: cur.memReq + r.memReq,
      memLim: cur.memLim + r.memLim,
      pods: cur.pods + 1,
    });
  }
  const metrics = new Map((raw.nodeMetrics ?? []).map((m) => [m.name, m]));

  const nodes = raw.nodes.map((n) => {
    const name = n.metadata?.name ?? '';
    const use = perNode.get(name) ?? { cpuReq: 0, cpuLim: 0, memReq: 0, memLim: 0, pods: 0 };
    const m = metrics.get(name);
    return {
      name,
      ready: !!n.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
      roles: Object.keys(n.metadata?.labels ?? {})
        .filter((l) => l.startsWith('node-role.kubernetes.io/'))
        .map((l) => l.slice('node-role.kubernetes.io/'.length)),
      cpu: {
        capacity: cpuMilli(n.status?.capacity?.cpu),
        allocatable: cpuMilli(n.status?.allocatable?.cpu),
        requests: use.cpuReq,
        limits: use.cpuLim,
        ...(m ? { usage: cpuMilli(m.cpu) } : {}),
      },
      memory: {
        capacity: parseQuantity(n.status?.capacity?.memory),
        allocatable: parseQuantity(n.status?.allocatable?.memory),
        requests: use.memReq,
        limits: use.memLim,
        ...(m ? { usage: parseQuantity(m.memory) } : {}),
      },
      pods: { count: use.pods, capacity: parseQuantity(n.status?.allocatable?.pods) },
      unschedulable: !!n.spec?.unschedulable,
    };
  });

  const meta = (o: { metadata?: { namespace?: string; name?: string } }) => ({
    namespace: o.metadata?.namespace ?? '',
    name: o.metadata?.name ?? '',
  });
  const workloads: DashboardWorkload[] = [
    ...raw.deployments.map((d) => {
      const desired = d.spec?.replicas ?? 1;
      const ready = d.status?.readyReplicas ?? 0;
      return {
        kind: 'Deployment' as const,
        ...meta(d),
        desired,
        ready,
        status: workloadStatus(desired, ready),
      };
    }),
    ...raw.statefulSets.map((s) => {
      const desired = s.spec?.replicas ?? 1;
      const ready = s.status?.readyReplicas ?? 0;
      return {
        kind: 'StatefulSet' as const,
        ...meta(s),
        desired,
        ready,
        status: workloadStatus(desired, ready),
      };
    }),
    ...raw.daemonSets.map((d) => {
      const desired = d.status?.desiredNumberScheduled ?? 0;
      const ready = d.status?.numberReady ?? 0;
      return {
        kind: 'DaemonSet' as const,
        ...meta(d),
        desired,
        ready,
        status: workloadStatus(desired, ready),
      };
    }),
    // Only running or failed jobs; completed ones are history.
    ...raw.jobs
      .filter(
        (j) => (j.status?.active ?? 0) > 0 || ((j.status?.failed ?? 0) > 0 && !j.status?.succeeded),
      )
      .map((j) => {
        const desired = j.spec?.completions ?? 1;
        const ready = j.status?.succeeded ?? 0;
        const failed = (j.status?.failed ?? 0) > 0 && !(j.status?.active ?? 0);
        return {
          kind: 'Job' as const,
          ...meta(j),
          desired,
          ready,
          status: failed ? ('degraded' as const) : ('progressing' as const),
        };
      }),
  ].sort(
    (a, b) =>
      rank(a.status) - rank(b.status) ||
      a.namespace.localeCompare(b.namespace) ||
      a.name.localeCompare(b.name),
  );

  const podPhases: Record<string, number> = {};
  for (const p of raw.pods) {
    const phase = p.status?.phase ?? 'Unknown';
    podPhases[phase] = (podPhases[phase] ?? 0) + 1;
  }
  const serviceCounts: Record<string, number> = {};
  for (const s of raw.services) {
    const type = s.spec?.type ?? 'ClusterIP';
    serviceCounts[type] = (serviceCounts[type] ?? 0) + 1;
  }

  const services = raw.services
    .filter((s) => s.spec?.type === 'LoadBalancer' || s.spec?.type === 'NodePort')
    .map((s) => ({
      ...meta(s),
      type: s.spec?.type ?? '',
      external: lbAddresses(s.status?.loadBalancer?.ingress),
      ports: (s.spec?.ports ?? []).map(
        (p) =>
          `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol ?? 'TCP'}${p.name ? ` (${p.name})` : ''}`,
      ),
    }));

  const ingresses = [
    ...raw.ingresses.map((i) => ({
      kind: 'Ingress' as const,
      ...meta(i),
      ...(i.spec?.ingressClassName ? { className: i.spec.ingressClassName } : {}),
      hosts: [...new Set((i.spec?.rules ?? []).map((r) => r.host ?? '*'))],
      tls: (i.spec?.tls?.length ?? 0) > 0,
      addresses: lbAddresses(i.status?.loadBalancer?.ingress),
      backends: [
        ...new Set(
          [
            ...(i.spec?.rules ?? [])
              .flatMap((r) => r.http?.paths ?? [])
              .map((p) => p.backend.service),
            i.spec?.defaultBackend?.service,
          ]
            .filter((s): s is NonNullable<typeof s> => !!s)
            .map((s) => `${s.name}:${s.port?.number ?? s.port?.name ?? ''}`),
        ),
      ],
    })),
    ...raw.httpRoutes.map((r) => ({
      kind: 'HTTPRoute' as const,
      ...meta(r),
      ...(r.spec?.parentRefs?.[0]?.name ? { className: r.spec.parentRefs[0].name } : {}),
      hosts: r.spec?.hostnames ?? ['*'],
      tls: false,
      addresses: [],
      backends: [
        ...new Set(
          (r.spec?.rules ?? [])
            .flatMap((x) => x.backendRefs ?? [])
            .map((b) => `${b.name ?? ''}:${b.port ?? ''}`),
        ),
      ],
    })),
  ];

  const events = raw.events
    .map((e) => {
      const lastSeen =
        e.series?.lastObservedTime ??
        e.lastTimestamp ??
        e.eventTime ??
        e.metadata?.creationTimestamp;
      return {
        type: e.type ?? 'Normal',
        reason: e.reason ?? '',
        message: (e.message ?? '').slice(0, 500),
        namespace: e.metadata?.namespace ?? '',
        object: { kind: e.involvedObject?.kind ?? '', name: e.involvedObject?.name ?? '' },
        count: e.series?.count ?? e.count ?? 1,
        ...(lastSeen ? { lastSeen: new Date(lastSeen as unknown as string).toISOString() } : {}),
      };
    })
    .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))
    .slice(0, DASHBOARD_EVENT_LIMIT);

  return {
    generatedAt: now.toISOString(),
    ...(raw.version ? { kubernetesVersion: raw.version } : {}),
    metricsAvailable: !!raw.nodeMetrics,
    totals: {
      nodes: nodes.length,
      readyNodes: nodes.filter((n) => n.ready).length,
      namespaces: raw.namespaces,
      pods: raw.pods.length,
      podPhases,
      services: serviceCounts,
    },
    nodes,
    workloads,
    problemPods: raw.pods
      .map(problemOf)
      .filter((p): p is ProblemPod => !!p)
      .sort((a, b) => b.restarts - a.restarts),
    services,
    ingresses,
    events,
    warnings: raw.warnings,
  };
}

const rank = (s: DashboardWorkload['status']) =>
  s === 'degraded' ? 0 : s === 'progressing' ? 1 : 2;
