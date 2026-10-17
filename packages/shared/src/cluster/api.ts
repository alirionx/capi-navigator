import { z } from 'zod';
import { ManifestPreviewSchema } from '../operator.js';
import { ClusterSpecSchema } from './spec.js';

/** Preview and create requests of the wizard (FP-5). */
export const ClusterCreateRequestSchema = z.object({
  spec: ClusterSpecSchema,
  /** Add the cluster's namespace to the credential's allowed namespaces (ADR-0002). */
  grantCredentialNamespace: z.boolean().default(false),
});
export type ClusterCreateRequest = z.input<typeof ClusterCreateRequestSchema>;

export const ClusterPreviewSchema = ManifestPreviewSchema.extend({
  /** Reasons that block the creation, e.g. missing providers (FP5-F-05, FP5-F-18). */
  blockers: z.array(z.string()),
  /** The credential does not allow the cluster's namespace yet. */
  credentialNamespaceMissing: z.boolean(),
});
export type ClusterPreview = z.infer<typeof ClusterPreviewSchema>;

export const ConditionSchema = z.object({
  type: z.string(),
  status: z.string(),
  reason: z.string().optional(),
  message: z.string().optional(),
  lastTransitionTime: z.string().optional(),
});
export type Condition = z.infer<typeof ConditionSchema>;

/** A workload cluster in the list (FP-5 status view; FP6-F-01 extends it). */
export const ClusterSummarySchema = z.object({
  name: z.string(),
  namespace: z.string(),
  provider: z.string().optional(),
  flavor: z.string().optional(),
  version: z.string().optional(),
  phase: z.string(),
  ready: z.boolean(),
  controlPlane: z.object({ replicas: z.number(), ready: z.number() }).optional(),
  workers: z.object({ replicas: z.number(), ready: z.number() }).optional(),
  labels: z.record(z.string(), z.string()),
  createdAt: z.string().optional(),
  /** Created by CAPI Navigator (has a stored spec). */
  managed: z.boolean(),
});
export type ClusterSummary = z.infer<typeof ClusterSummarySchema>;
export const ClusterListSchema = z.array(ClusterSummarySchema);

export const MachineStatusSchema = z.object({
  name: z.string(),
  role: z.enum(['control-plane', 'worker']),
  pool: z.string().optional(),
  phase: z.string(),
  nodeName: z.string().optional(),
  providerID: z.string().optional(),
  version: z.string().optional(),
  failureDomain: z.string().optional(),
  conditions: z.array(ConditionSchema),
  createdAt: z.string().optional(),
});
export type MachineStatus = z.infer<typeof MachineStatusSchema>;

/** Live status of one cluster (US-07). */
export const ClusterStatusSchema = z.object({
  summary: ClusterSummarySchema,
  conditions: z.array(ConditionSchema),
  infrastructure: z
    .object({
      kind: z.string(),
      name: z.string(),
      ready: z.boolean(),
      conditions: z.array(ConditionSchema),
    })
    .optional(),
  controlPlane: z
    .object({
      kind: z.string(),
      name: z.string(),
      replicas: z.number(),
      ready: z.number(),
      version: z.string().optional(),
      conditions: z.array(ConditionSchema),
    })
    .optional(),
  machineDeployments: z.array(
    z.object({
      name: z.string(),
      pool: z.string().optional(),
      replicas: z.number(),
      ready: z.number(),
      upToDate: z.number(),
    }),
  ),
  machines: z.array(MachineStatusSchema),
  /** Kubeconfig Secret exists (download in FP-6). */
  kubeconfigAvailable: z.boolean(),
});
export type ClusterStatus = z.infer<typeof ClusterStatusSchema>;
