import {
  CLUSTER_SPEC_ANNOTATION,
  DELETION_ANNOTATION,
  DeletionStatusSchema,
  EVENT_LIMIT,
  FLAVOR_PLUGINS,
  INFRA_PLUGINS,
  type ClusterEvent,
  type ClusterStatus,
  type ClusterSummary,
  type Condition,
  type DeletionStatus,
  type MachineStatus,
} from '@capi-navigator/shared';

/** Loose shapes of CAPI v1beta2 objects (only what the status view reads). */
export interface K8sObj {
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
  };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  kind?: string;
}

const CLUSTER_NAME_LABEL = 'cluster.x-k8s.io/cluster-name';
const CP_LABEL = 'cluster.x-k8s.io/control-plane';
const DEPLOYMENT_LABEL = 'cluster.x-k8s.io/deployment-name';

/** Infra provider plugin of a cluster, by the kind of its infrastructure cluster. */
export function infraPluginFor(infraKind: string | undefined) {
  return Object.values(INFRA_PLUGINS).find((p) => p.infraClusterKind === infraKind);
}

/** Distribution of a cluster, by the kind of its control plane (also for external clusters). */
export function flavorFor(cpKind: string | undefined): string | undefined {
  return Object.values(FLAVOR_PLUGINS).find((p) => p?.controlPlaneResource.kind === cpKind)?.flavor;
}

export function conditions(obj: K8sObj | undefined): Condition[] {
  const raw = (obj?.status?.conditions as Record<string, unknown>[] | undefined) ?? [];
  return raw.map((c) => ({
    type: String(c.type),
    status: String(c.status),
    ...(c.reason ? { reason: String(c.reason) } : {}),
    ...(c.message ? { message: String(c.message) } : {}),
    ...(c.lastTransitionTime ? { lastTransitionTime: String(c.lastTransitionTime) } : {}),
  }));
}

const isTrue = (obj: K8sObj | undefined, type: string) =>
  conditions(obj).some((c) => c.type === type && c.status === 'True');

const num = (v: unknown) => (typeof v === 'number' ? v : 0);

/** Cluster list entry (FP-5 status view; FP6-F-01 builds on it). */
export function toSummary(cluster: K8sObj, cp?: K8sObj, mds: K8sObj[] = []): ClusterSummary {
  const spec = cluster.spec ?? {};
  const infraKind = (spec.infrastructureRef as { kind?: string } | undefined)?.kind ?? '';
  const cpKind = (spec.controlPlaneRef as { kind?: string } | undefined)?.kind;
  const stored = cluster.metadata.annotations?.[CLUSTER_SPEC_ANNOTATION];
  let flavor: string | undefined;
  try {
    flavor = stored
      ? (JSON.parse(stored) as { kubernetes?: { flavor?: string } }).kubernetes?.flavor
      : undefined;
  } catch {
    flavor = undefined;
  }
  flavor ??= flavorFor(cpKind);
  const workers = mds.reduce(
    (acc, md) => ({
      replicas: acc.replicas + num(md.spec?.replicas),
      ready: acc.ready + num(md.status?.readyReplicas),
    }),
    { replicas: 0, ready: 0 },
  );
  return {
    name: cluster.metadata.name,
    namespace: cluster.metadata.namespace ?? 'default',
    provider: infraPluginFor(infraKind)?.provider ?? (infraKind || undefined),
    ...(flavor ? { flavor } : {}),
    ...(cp?.spec?.version ? { version: String(cp.spec.version) } : {}),
    phase: String(cluster.status?.phase ?? 'Pending'),
    // CAPI v1beta2: the Available condition summarizes the cluster.
    ready: isTrue(cluster, 'Available'),
    ...(cp
      ? {
          controlPlane: {
            replicas: num(cp.spec?.replicas),
            ready: num(cp.status?.availableReplicas ?? cp.status?.readyReplicas),
          },
        }
      : {}),
    ...(mds.length > 0 ? { workers } : {}),
    labels: cluster.metadata.labels ?? {},
    ...(cluster.metadata.creationTimestamp
      ? { createdAt: String(cluster.metadata.creationTimestamp) }
      : {}),
    managed: !!stored,
    ...deletionOf(cluster),
  };
}

/** Deletion progress from the annotation the app sets (FP6-F-06). */
function deletionOf(cluster: K8sObj): { deletion?: DeletionStatus } {
  const raw = cluster.metadata.annotations?.[DELETION_ANNOTATION];
  if (!raw) return {};
  try {
    const parsed = DeletionStatusSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { deletion: parsed.data } : {};
  } catch {
    return {};
  }
}

/**
 * One machine; with its infra machine, size, image and root disk come from the infra plugin
 * (FP6-F-02, hard rule 10).
 */
export function toMachine(m: K8sObj, infraMachine?: K8sObj): MachineStatus {
  const labels = m.metadata.labels ?? {};
  const role = CP_LABEL in labels ? 'control-plane' : 'worker';
  const nodeRef = m.status?.nodeRef as { name?: string } | undefined;
  const infraRef = m.spec?.infrastructureRef as { kind?: string; name?: string } | undefined;
  const plugin = Object.values(INFRA_PLUGINS).find(
    (p) => p.resources.machineKind === infraRef?.kind,
  );
  const details = infraMachine && plugin ? plugin.machineDetails(infraMachine.spec ?? {}) : {};
  const infraInit = infraMachine?.status?.initialization as { provisioned?: boolean } | undefined;
  return {
    name: m.metadata.name,
    role,
    ...(role === 'worker' && labels['capi-navigator.io/pool']
      ? { pool: labels['capi-navigator.io/pool'] }
      : {}),
    phase: String(m.status?.phase ?? 'Pending'),
    ...(nodeRef?.name ? { nodeName: nodeRef.name } : {}),
    ...(m.spec?.providerID ? { providerID: String(m.spec.providerID) } : {}),
    ...(m.spec?.version ? { version: String(m.spec.version) } : {}),
    ...(m.spec?.failureDomain ? { failureDomain: String(m.spec.failureDomain) } : {}),
    ...(labels[DEPLOYMENT_LABEL] ? { deployment: labels[DEPLOYMENT_LABEL] } : {}),
    ...internalIP(m),
    ...details,
    ...(infraRef?.kind && infraRef.name
      ? {
          infrastructure: {
            kind: infraRef.kind,
            name: infraRef.name,
            ready: infraInit?.provisioned === true || infraMachine?.status?.ready === true,
          },
        }
      : {}),
    conditions: conditions(m),
    ...(m.metadata.creationTimestamp ? { createdAt: String(m.metadata.creationTimestamp) } : {}),
  };
}

/** Loose shape of a core/v1 Event. */
export interface K8sEvent {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  involvedObject?: { kind?: string; name?: string };
  lastTimestamp?: string;
  eventTime?: string;
  series?: { count?: number; lastObservedTime?: string };
  metadata?: { creationTimestamp?: string };
}

/** Events about the given objects, newest first (FP6-F-02). */
export function toEvents(events: K8sEvent[], objects: { kind?: string; name: string }[]) {
  const wanted = new Set(objects.map((o) => `${o.kind ?? ''}/${o.name}`));
  return events
    .filter((e) => wanted.has(`${e.involvedObject?.kind ?? ''}/${e.involvedObject?.name ?? ''}`))
    .map((e): ClusterEvent => ({
      type: e.type ?? 'Normal',
      reason: e.reason ?? '',
      message: e.message ?? '',
      object: { kind: e.involvedObject?.kind ?? '', name: e.involvedObject?.name ?? '' },
      count: e.series?.count ?? e.count ?? 1,
      ...((e.series?.lastObservedTime ??
      e.lastTimestamp ??
      e.eventTime ??
      e.metadata?.creationTimestamp)
        ? {
            lastSeen: String(
              e.series?.lastObservedTime ??
                e.lastTimestamp ??
                e.eventTime ??
                e.metadata?.creationTimestamp,
            ),
          }
        : {}),
    }))
    .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))
    .slice(0, EVENT_LIMIT);
}

export function toStatus(args: {
  cluster: K8sObj;
  infra?: K8sObj;
  cp?: K8sObj;
  mds: K8sObj[];
  machines: K8sObj[];
  infraMachines?: K8sObj[];
  events?: K8sEvent[];
  kubeconfigAvailable: boolean;
}): ClusterStatus {
  const { cluster, infra, cp, mds, machines } = args;
  const infraMachine = (m: K8sObj) => {
    const ref = m.spec?.infrastructureRef as { name?: string } | undefined;
    return args.infraMachines?.find((x) => x.metadata.name === ref?.name);
  };
  const objects = [
    { kind: 'Cluster', name: cluster.metadata.name },
    ...[infra, cp, ...mds, ...machines, ...(args.infraMachines ?? [])]
      .filter((o): o is K8sObj => !!o)
      .map((o) => ({ kind: o.kind, name: o.metadata.name })),
  ];
  const initialization = infra?.status?.initialization as { provisioned?: boolean } | undefined;
  return {
    summary: toSummary(cluster, cp, mds),
    conditions: conditions(cluster),
    ...(infra
      ? {
          infrastructure: {
            kind: infra.kind ?? '',
            name: infra.metadata.name,
            ready: initialization?.provisioned === true || infra.status?.ready === true,
            conditions: conditions(infra),
          },
        }
      : {}),
    ...(cp
      ? {
          controlPlane: {
            kind: cp.kind ?? '',
            name: cp.metadata.name,
            replicas: num(cp.spec?.replicas),
            ready: num(cp.status?.availableReplicas ?? cp.status?.readyReplicas),
            ...(cp.spec?.version ? { version: String(cp.spec.version) } : {}),
            conditions: conditions(cp),
          },
        }
      : {}),
    machineDeployments: mds.map((md) => ({
      name: md.metadata.name,
      // MachineDeployments created by the app are named <cluster>-<pool>.
      ...(md.metadata.name.startsWith(`${cluster.metadata.name}-`)
        ? { pool: md.metadata.name.slice(cluster.metadata.name.length + 1) }
        : {}),
      replicas: num(md.spec?.replicas),
      ready: num(md.status?.readyReplicas),
      upToDate: num(md.status?.upToDateReplicas),
      ...(md.status?.phase ? { phase: String(md.status.phase) } : {}),
      conditions: conditions(md),
    })),
    machines: machines
      .map((m) => toMachine(m, infraMachine(m)))
      .sort((a, b) =>
        a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'control-plane' ? -1 : 1,
      ),
    events: toEvents(args.events ?? [], objects),
    kubeconfigAvailable: args.kubeconfigAvailable,
  };
}

export { CLUSTER_NAME_LABEL };

/** First InternalIP of a machine (target of `ssh -J` via the bastion, FP5-F-20). */
function internalIP(m: K8sObj): { internalIP?: string } {
  const addresses =
    (m.status?.addresses as { type?: string; address?: string }[] | undefined) ?? [];
  const ip = addresses.find((a) => a.type === 'InternalIP')?.address;
  return ip ? { internalIP: ip } : {};
}
