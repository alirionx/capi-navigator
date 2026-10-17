import { z } from 'zod';

/**
 * Read-only YAML view (FP7-F-01 to F-05). A reference to one object, either in the management
 * cluster or, with `cluster`, inside a workload cluster (dashboard resources, FP-18).
 */
export const ResourceRefSchema = z.object({
  apiVersion: z.string().min(1).max(255),
  kind: z.string().min(1).max(255),
  namespace: z.string().max(253).optional(),
  name: z.string().min(1).max(253),
  /** Workload cluster that holds the object (namespace/name of the CAPI Cluster). */
  cluster: z.object({ namespace: z.string(), name: z.string() }).optional(),
});
export type ResourceRef = z.infer<typeof ResourceRefSchema>;

const group = (apiVersion: string) => (apiVersion.includes('/') ? apiVersion.split('/')[0]! : '');

/** API groups of the app's world in the management cluster: CAPI, providers, operator, ORC. */
const MANAGEMENT_GROUPS = new Set([
  'cluster.x-k8s.io',
  'infrastructure.cluster.x-k8s.io',
  'bootstrap.cluster.x-k8s.io',
  'controlplane.cluster.x-k8s.io',
  'addons.cluster.x-k8s.io',
  'ipam.cluster.x-k8s.io',
  'operator.cluster.x-k8s.io',
  'openstack.k-orc.cloud',
  'navigator.capi-navigator.io',
]);
const MANAGEMENT_CORE = new Set(['Secret', 'ConfigMap', 'Namespace', 'Node']);

/** Workload cluster objects shown on the dashboard (FP-18); no Secrets or ConfigMaps. */
const WORKLOAD_KINDS: Record<string, Set<string>> = {
  '': new Set([
    'Pod',
    'Service',
    'Node',
    'Namespace',
    'Event',
    'PersistentVolumeClaim',
    'PersistentVolume',
  ]),
  apps: new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet']),
  batch: new Set(['Job', 'CronJob']),
  'networking.k8s.io': new Set(['Ingress', 'IngressClass']),
  'gateway.networking.k8s.io': new Set(['HTTPRoute', 'Gateway']),
};

/** Whether the YAML view may show the object (keeps it from becoming a generic cluster reader). */
export function isViewable(ref: ResourceRef): boolean {
  const g = group(ref.apiVersion);
  if (ref.cluster) return WORKLOAD_KINDS[g]?.has(ref.kind) ?? false;
  return g === '' ? MANAGEMENT_CORE.has(ref.kind) : MANAGEMENT_GROUPS.has(g);
}

export const ResourceYamlSchema = z.object({
  yaml: z.string(),
  /** Secret values were replaced (FP7-F-04). */
  masked: z.boolean(),
});
export type ResourceYaml = z.infer<typeof ResourceYamlSchema>;

/** Objects that belong to a cluster in the management cluster (resources tab, FP7-F-01). */
export const ClusterResourceListSchema = z.array(
  z.object({
    apiVersion: z.string(),
    kind: z.string(),
    namespace: z.string().optional(),
    name: z.string(),
  }),
);
export type ClusterResourceList = z.infer<typeof ClusterResourceListSchema>;
