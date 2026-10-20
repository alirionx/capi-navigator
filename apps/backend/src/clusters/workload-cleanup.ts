import { AppsV1Api, BatchV1Api, CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import { MANIFEST_ADDONS } from '@capi-navigator/shared';

/**
 * Cleanup inside a workload cluster before it is deleted (FP6-F-06): CAPO does not remove load
 * balancers, floating IPs and volumes that the CCM and CSI driver created, and they block the
 * deletion of the cluster network. Deleting the workloads, LoadBalancer services and PVCs while
 * CCM and CSI still run lets them release these cloud resources.
 */
export interface WorkloadApi {
  listNamespaces(): Promise<string[]>;
  deleteNamespace(name: string): Promise<void>;
  /** Deletes Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs, CronJobs and Pods. */
  deleteWorkloads(namespace: string): Promise<void>;
  listLoadBalancers(): Promise<{ namespace: string; name: string }[]>;
  deleteService(namespace: string, name: string): Promise<void>;
  listClaims(): Promise<{ namespace: string; name: string; volume?: string; size?: string }[]>;
  deleteClaim(namespace: string, name: string): Promise<void>;
  listVolumes(): Promise<{ name: string; reclaimPolicy?: string; claim?: string }[]>;
}

/** Namespaces of the manifest add-ons, e.g. the GCP PD CSI driver (ADR-0023). */
const ADDON_NAMESPACES = new Set(MANIFEST_ADDONS.flatMap((a) => a.namespaces ?? []));

/** Namespaces of Kubernetes, the distribution, the CNI and the add-ons; never deleted. */
export function isSystemNamespace(name: string): boolean {
  return (
    ['default', 'kube-system', 'kube-public', 'kube-node-lease'].includes(name) ||
    ADDON_NAMESPACES.has(name) ||
    /^(calico-|tigera-|cattle-|cilium)/.test(name)
  );
}

export interface CleanupInventory {
  namespaces: string[];
  loadBalancers: string[];
  volumes: string[];
  retainedVolumes: string[];
}

export async function inventory(api: WorkloadApi): Promise<CleanupInventory> {
  const [namespaces, lbs, claims, volumes] = await Promise.all([
    api.listNamespaces(),
    api.listLoadBalancers(),
    api.listClaims(),
    api.listVolumes(),
  ]);
  const retained = new Set(
    volumes.filter((v) => v.reclaimPolicy === 'Retain').map((v) => v.claim ?? v.name),
  );
  const claimName = (c: { namespace: string; name: string }) => `${c.namespace}/${c.name}`;
  return {
    namespaces: namespaces.filter((n) => !isSystemNamespace(n)),
    loadBalancers: lbs.map((s) => `${s.namespace}/${s.name}`),
    volumes: claims
      .filter((c) => !retained.has(claimName(c)))
      .map((c) => `${claimName(c)}${c.size ? ` (${c.size})` : ''}`),
    retainedVolumes: volumes
      .filter((v) => v.reclaimPolicy === 'Retain')
      .map((v) => v.claim ?? v.name),
  };
}

/** Starts the cleanup; returns immediately (deletions run in the workload cluster). */
export async function startCleanup(api: WorkloadApi): Promise<void> {
  const namespaces = await api.listNamespaces();
  for (const ns of namespaces.filter((n) => !isSystemNamespace(n))) await api.deleteNamespace(ns);
  // Workloads in "default" hold PVCs (pvc-protection); system namespaces keep theirs running.
  await api.deleteWorkloads('default');
  for (const s of await api.listLoadBalancers()) await api.deleteService(s.namespace, s.name);
  for (const c of await api.listClaims()) await api.deleteClaim(c.namespace, c.name);
}

/** Cloud resources still held: LoadBalancer services and volumes that will be deleted. */
export async function remaining(api: WorkloadApi): Promise<string[]> {
  const [lbs, volumes] = await Promise.all([api.listLoadBalancers(), api.listVolumes()]);
  return [
    ...lbs.map((s) => `Service ${s.namespace}/${s.name}`),
    ...volumes.filter((v) => v.reclaimPolicy !== 'Retain').map((v) => `PersistentVolume ${v.name}`),
  ];
}

const ignoreNotFound = (err: unknown) => {
  if ((err as { code?: number }).code !== 404) throw err;
};

/** WorkloadApi on top of the Kubernetes client, with a short request timeout. */
export function workloadApi(kubeconfig: string): WorkloadApi {
  const kc = new KubeConfig();
  kc.loadFromString(kubeconfig);
  const core = kc.makeApiClient(CoreV1Api);
  const apps = kc.makeApiClient(AppsV1Api);
  const batch = kc.makeApiClient(BatchV1Api);
  return {
    listNamespaces: async () => (await core.listNamespace()).items.map((n) => n.metadata!.name!),
    deleteNamespace: (name) => core.deleteNamespace({ name }).then(() => undefined, ignoreNotFound),
    deleteWorkloads: async (namespace) => {
      const opts = { namespace, propagationPolicy: 'Background' };
      await Promise.all([
        apps.deleteCollectionNamespacedDeployment(opts),
        apps.deleteCollectionNamespacedStatefulSet(opts),
        apps.deleteCollectionNamespacedDaemonSet(opts),
        apps.deleteCollectionNamespacedReplicaSet(opts),
        batch.deleteCollectionNamespacedJob(opts),
        batch.deleteCollectionNamespacedCronJob(opts),
      ]);
      await core.deleteCollectionNamespacedPod({ namespace });
    },
    listLoadBalancers: async () =>
      (await core.listServiceForAllNamespaces()).items
        .filter((s) => s.spec?.type === 'LoadBalancer')
        .map((s) => ({ namespace: s.metadata!.namespace!, name: s.metadata!.name! })),
    deleteService: (namespace, name) =>
      core.deleteNamespacedService({ namespace, name }).then(() => undefined, ignoreNotFound),
    listClaims: async () =>
      (await core.listPersistentVolumeClaimForAllNamespaces()).items.map((c) => ({
        namespace: c.metadata!.namespace!,
        name: c.metadata!.name!,
        ...(c.spec?.volumeName ? { volume: c.spec.volumeName } : {}),
        ...(c.spec?.resources?.requests?.storage
          ? { size: String(c.spec.resources.requests.storage) }
          : {}),
      })),
    deleteClaim: (namespace, name) =>
      core
        .deleteNamespacedPersistentVolumeClaim({ namespace, name })
        .then(() => undefined, ignoreNotFound),
    listVolumes: async () =>
      (await core.listPersistentVolume()).items.map((v) => ({
        name: v.metadata!.name!,
        ...(v.spec?.persistentVolumeReclaimPolicy
          ? { reclaimPolicy: v.spec.persistentVolumeReclaimPolicy }
          : {}),
        ...(v.spec?.claimRef?.name
          ? { claim: `${v.spec.claimRef.namespace}/${v.spec.claimRef.name}` }
          : {}),
      })),
  };
}
