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
  type DashboardService,
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
    rules?: {
      matches?: { path?: { value?: string } }[];
      backendRefs?: { name?: string; namespace?: string; kind?: string; port?: number }[];
    }[];
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

const podReady = (p: V1Pod) =>
  !!p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');

/** The workload owning a pod: a Deployment through its ReplicaSet (pod-template-hash). */
function ownerOf(pod: V1Pod): { kind: string; name: string } | undefined {
  const ref = pod.metadata?.ownerReferences?.find((r) => r.controller);
  if (!ref) return undefined;
  const hash = pod.metadata?.labels?.['pod-template-hash'];
  if (ref.kind === 'ReplicaSet' && hash && ref.name.endsWith(`-${hash}`)) {
    return { kind: 'Deployment', name: ref.name.slice(0, -hash.length - 1) };
  }
  return { kind: ref.kind, name: ref.name };
}

const routePath = (host: string, path?: string) => `${host}${path && path !== '/' ? path : ''}`;

/**
 * Services with their routes, ready endpoints and workloads (FP18-F-03, UX-09); routes to a
 * service that does not exist come out as missing services.
 */
function servicesView(raw: DashboardRaw): DashboardService[] {
  const key = (ns: string, name: string) => `${ns}/${name}`;
  const routes = new Map<string, DashboardService['routes']>();
  const addRoute = (ns: string, svc: string, r: DashboardService['routes'][number]) => {
    const list = routes.get(key(ns, svc)) ?? [];
    if (!list.some((x) => x.kind === r.kind && x.name === r.name && x.host === r.host))
      list.push(r);
    routes.set(key(ns, svc), list);
  };
  for (const i of raw.ingresses) {
    const ns = i.metadata?.namespace ?? '';
    const name = i.metadata?.name ?? '';
    const tlsHosts = new Set((i.spec?.tls ?? []).flatMap((t) => t.hosts ?? []));
    const anyTls = (i.spec?.tls?.length ?? 0) > 0;
    for (const rule of i.spec?.rules ?? []) {
      const host = rule.host ?? '*';
      for (const p of rule.http?.paths ?? []) {
        if (!p.backend.service) continue;
        addRoute(ns, p.backend.service.name, {
          kind: 'Ingress',
          name,
          host: routePath(host, p.path),
          tls: tlsHosts.has(host) || (anyTls && !rule.host),
        });
      }
    }
    const def = i.spec?.defaultBackend?.service;
    if (def) addRoute(ns, def.name, { kind: 'Ingress', name, host: '*', tls: anyTls });
  }
  for (const r of raw.httpRoutes) {
    const ns = r.metadata?.namespace ?? '';
    const name = r.metadata?.name ?? '';
    for (const rule of r.spec?.rules ?? []) {
      const paths = (rule.matches ?? []).map((m) => m.path?.value).filter((v) => !!v);
      for (const b of rule.backendRefs ?? []) {
        if (!b.name || (b.kind && b.kind !== 'Service')) continue;
        for (const host of r.spec?.hostnames?.length ? r.spec.hostnames : ['*']) {
          for (const path of paths.length ? paths : [undefined]) {
            addRoute(b.namespace ?? ns, b.name, {
              kind: 'HTTPRoute',
              name,
              host: routePath(host, path),
              tls: false,
            });
          }
        }
      }
    }
  }

  const pods = raw.pods.filter(active);
  const services: DashboardService[] = raw.services.map((s) => {
    const ns = s.metadata?.namespace ?? '';
    const name = s.metadata?.name ?? '';
    const type = s.spec?.type ?? 'ClusterIP';
    const selector = s.spec?.selector ?? {};
    const hasSelector = Object.keys(selector).length > 0;
    const behind = hasSelector
      ? pods.filter(
          (p) =>
            p.metadata?.namespace === ns &&
            Object.entries(selector).every(([k, v]) => p.metadata?.labels?.[k] === v),
        )
      : [];
    const ready = behind.filter(podReady).length;
    const owners = new Map<string, { kind: string; name: string }>();
    for (const p of behind) {
      const o = ownerOf(p) ?? { kind: 'Pod', name: p.metadata?.name ?? '' };
      owners.set(`${o.kind}/${o.name}`, o);
    }
    return {
      namespace: ns,
      name,
      type,
      external:
        type === 'ExternalName' && s.spec?.externalName
          ? [s.spec.externalName]
          : lbAddresses(s.status?.loadBalancer?.ingress),
      ports: (s.spec?.ports ?? []).map(
        (p) =>
          `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol ?? 'TCP'}${p.name ? ` (${p.name})` : ''}`,
      ),
      ...(hasSelector ? { endpoints: { ready, total: behind.length } } : {}),
      status: !hasSelector
        ? 'none'
        : behind.length === 0
          ? 'degraded'
          : workloadStatus(behind.length, ready),
      workloads: [...owners.values()].sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
      ),
      routes: routes.get(key(ns, name)) ?? [],
    };
  });
  const present = new Set(services.map((s) => key(s.namespace, s.name)));
  for (const [k, list] of routes) {
    if (present.has(k)) continue;
    const [namespace = '', name = ''] = k.split('/');
    services.push({
      namespace,
      name,
      type: '',
      external: [],
      ports: [],
      status: 'degraded',
      workloads: [],
      routes: list,
      missing: true,
    });
  }
  const exposed = (s: DashboardService) =>
    s.type === 'LoadBalancer' || s.type === 'NodePort' || s.routes.length > 0;
  const order = (s: DashboardService) =>
    s.status === 'degraded' ? 0 : s.status === 'progressing' ? 1 : 2;
  return services.sort(
    (a, b) =>
      order(a) - order(b) ||
      Number(exposed(b)) - Number(exposed(a)) ||
      a.namespace.localeCompare(b.namespace) ||
      a.name.localeCompare(b.name),
  );
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

  const services = servicesView(raw);

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
