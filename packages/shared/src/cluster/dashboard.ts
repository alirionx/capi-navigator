import { z } from 'zod';

/**
 * Read-only dashboard of a workload cluster (FP-18): usage, workloads, network and events,
 * read with the cluster's CAPI kubeconfig. Never contains Secret or ConfigMap content.
 */

const SUFFIX: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

/** Kubernetes quantity ("250m", "2", "1.5Gi", "128974848", "1e3") as a number of base units. */
export function parseQuantity(q: string | number | undefined): number {
  if (q === undefined) return 0;
  if (typeof q === 'number') return q;
  const m = /^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)([a-zA-Z]{0,2})$/.exec(q.trim());
  if (!m) return 0;
  const factor = SUFFIX[m[2]!];
  return factor === undefined ? 0 : Number(m[1]) * factor;
}

/** CPU in millicores. */
export const cpuMilli = (q: string | number | undefined) => Math.round(parseQuantity(q) * 1000);

const ResourceUseSchema = z.object({
  capacity: z.number(),
  allocatable: z.number(),
  requests: z.number(),
  limits: z.number(),
  /** From metrics-server; absent without metrics. */
  usage: z.number().optional(),
});
export type ResourceUse = z.infer<typeof ResourceUseSchema>;

export const DashboardNodeSchema = z.object({
  name: z.string(),
  ready: z.boolean(),
  roles: z.array(z.string()),
  /** CPU in millicores. */
  cpu: ResourceUseSchema,
  /** Memory in bytes. */
  memory: ResourceUseSchema,
  pods: z.object({ count: z.number(), capacity: z.number() }),
  unschedulable: z.boolean(),
});
export type DashboardNode = z.infer<typeof DashboardNodeSchema>;

export const DashboardWorkloadSchema = z.object({
  kind: z.enum(['Deployment', 'StatefulSet', 'DaemonSet', 'Job']),
  namespace: z.string(),
  name: z.string(),
  desired: z.number(),
  ready: z.number(),
  status: z.enum(['ok', 'progressing', 'degraded']),
});
export type DashboardWorkload = z.infer<typeof DashboardWorkloadSchema>;

export const ProblemPodSchema = z.object({
  namespace: z.string(),
  name: z.string(),
  node: z.string().optional(),
  phase: z.string(),
  reason: z.string(),
  restarts: z.number(),
  message: z.string().optional(),
});
export type ProblemPod = z.infer<typeof ProblemPodSchema>;

export const DashboardServiceSchema = z.object({
  namespace: z.string(),
  name: z.string(),
  type: z.string(),
  /** External IPs / hostnames of LoadBalancer services. */
  external: z.array(z.string()),
  ports: z.array(z.string()),
});

export const DashboardIngressSchema = z.object({
  kind: z.enum(['Ingress', 'HTTPRoute']),
  namespace: z.string(),
  name: z.string(),
  className: z.string().optional(),
  hosts: z.array(z.string()),
  tls: z.boolean(),
  addresses: z.array(z.string()),
  /** Backend services. */
  backends: z.array(z.string()),
});

export const DashboardEventSchema = z.object({
  type: z.string(),
  reason: z.string(),
  message: z.string(),
  namespace: z.string(),
  object: z.object({ kind: z.string(), name: z.string() }),
  count: z.number(),
  lastSeen: z.string().optional(),
});

export const DashboardSchema = z.object({
  generatedAt: z.string(),
  kubernetesVersion: z.string().optional(),
  metricsAvailable: z.boolean(),
  totals: z.object({
    nodes: z.number(),
    readyNodes: z.number(),
    namespaces: z.number(),
    pods: z.number(),
    podPhases: z.record(z.string(), z.number()),
    services: z.record(z.string(), z.number()),
  }),
  nodes: z.array(DashboardNodeSchema),
  workloads: z.array(DashboardWorkloadSchema),
  problemPods: z.array(ProblemPodSchema),
  services: z.array(DashboardServiceSchema),
  ingresses: z.array(DashboardIngressSchema),
  events: z.array(DashboardEventSchema),
  /** Parts that could not be read (permissions, API not installed), shown as hints. */
  warnings: z.array(z.string()),
});
export type Dashboard = z.infer<typeof DashboardSchema>;

export const DASHBOARD_EVENT_LIMIT = 100;
export const DASHBOARD_REFRESH_SECONDS = 15;
