import {
  CLUSTER_SPEC_ANNOTATION,
  type ClusterStatus,
  type ClusterSummary,
  type Condition,
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
  const stored = cluster.metadata.annotations?.[CLUSTER_SPEC_ANNOTATION];
  let flavor: string | undefined;
  try {
    flavor = stored
      ? (JSON.parse(stored) as { kubernetes?: { flavor?: string } }).kubernetes?.flavor
      : undefined;
  } catch {
    flavor = undefined;
  }
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
    provider: infraKind.startsWith('OpenStack')
      ? 'openstack'
      : infraKind.startsWith('AWS')
        ? 'aws'
        : infraKind || undefined,
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
  };
}

export function toMachine(m: K8sObj): MachineStatus {
  const labels = m.metadata.labels ?? {};
  const role = CP_LABEL in labels ? 'control-plane' : 'worker';
  const nodeRef = m.status?.nodeRef as { name?: string } | undefined;
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
    conditions: conditions(m),
    ...(m.metadata.creationTimestamp ? { createdAt: String(m.metadata.creationTimestamp) } : {}),
  };
}

export function toStatus(args: {
  cluster: K8sObj;
  infra?: K8sObj;
  cp?: K8sObj;
  mds: K8sObj[];
  machines: K8sObj[];
  kubeconfigAvailable: boolean;
}): ClusterStatus {
  const { cluster, infra, cp, mds, machines } = args;
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
    })),
    machines: machines
      .map(toMachine)
      .sort((a, b) =>
        a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'control-plane' ? -1 : 1,
      ),
    kubeconfigAvailable: args.kubeconfigAvailable,
  };
}

export { CLUSTER_NAME_LABEL };
