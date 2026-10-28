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

/**
 * FP29-F-12: an artifact the internal registry lacks, with the commands that download it from the
 * upstream release and push it (run on a machine with internet access).
 */
export const MissingArtifactSchema = z.object({
  /** host/repository:tag in the internal registry. */
  reference: z.string(),
  commands: z.string(),
});
export type MissingArtifact = z.infer<typeof MissingArtifactSchema>;

export const ClusterPreviewSchema = ManifestPreviewSchema.extend({
  /** Reasons that block the creation, e.g. missing providers (FP5-F-05, FP5-F-18). */
  blockers: z.array(z.string()),
  /** The credential does not allow the cluster's namespace yet. */
  credentialNamespaceMissing: z.boolean(),
  /** Artifacts missing in the internal registry, each also a blocker (FP29-F-12). */
  missingArtifacts: z.array(MissingArtifactSchema).optional(),
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
/** Progress of a deletion, stored as annotation on the Cluster (stateless backend). */
export const DELETION_ANNOTATION = 'capi-navigator.io/deletion';
export const DeletionStatusSchema = z.object({
  phase: z.enum(['cleanup', 'cleanup-timeout', 'deleting']),
  startedAt: z.string(),
  message: z.string().optional(),
});
export type DeletionStatus = z.infer<typeof DeletionStatusSchema>;

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
  /** Deletion in progress through the app (FP6-F-06). */
  deletion: DeletionStatusSchema.optional(),
  /** The cluster's machines in brief, for the shape of every cluster on the home page (UX-02). */
  machines: z
    .array(
      z.object({
        name: z.string(),
        role: z.enum(['control-plane', 'worker']),
        pool: z.string().optional(),
        phase: z.string(),
        /** Machine condition Ready (node healthy). */
        ready: z.boolean(),
      }),
    )
    .optional(),
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
  /** MachineDeployment of a worker machine (resource tree, FP6-F-03). */
  deployment: z.string().optional(),
  /** Node address in the cluster network, the target behind the bastion (FP5-F-20). */
  internalIP: z.string().optional(),
  /** Flavor / instance type, image and root disk from the infra machine (FP6-F-02). */
  size: z.string().optional(),
  image: z.string().optional(),
  /** Name of the image in the cloud, resolved with the cluster's credentials (if found). */
  imageName: z.string().optional(),
  rootVolumeGB: z.number().optional(),
  infrastructure: z.object({ kind: z.string(), name: z.string(), ready: z.boolean() }).optional(),
  conditions: z.array(ConditionSchema),
  createdAt: z.string().optional(),
});
export type MachineStatus = z.infer<typeof MachineStatusSchema>;

/** Kubernetes event about one of the cluster's objects (FP6-F-02). */
export const ClusterEventSchema = z.object({
  type: z.string(),
  reason: z.string(),
  message: z.string(),
  object: z.object({ kind: z.string(), name: z.string() }),
  count: z.number(),
  lastSeen: z.string().optional(),
});
export type ClusterEvent = z.infer<typeof ClusterEventSchema>;

/** An image with the name the cloud reports for it (OpenStack image / AWS AMI). */
export const ImageRefSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  /** The cloud does not know the ID (deleted, or not visible to the credentials). */
  notFound: z.boolean().optional(),
});
export type ImageRef = z.infer<typeof ImageRefSchema>;

/** What the cluster is built from, per machine group, from the stored spec (managed clusters). */
export const InfraSummarySchema = z.object({
  provider: z.string(),
  /** Stored credentials of the cluster (for selection lists in day-2 dialogs). */
  credentialRef: z.string(),
  region: z.string().optional(),
  sshKeyName: z.string().optional(),
  facts: z.array(z.object({ label: z.string(), value: z.string() })),
  groups: z.array(
    z.object({
      name: z.string(),
      role: z.enum(['control-plane', 'worker']),
      replicas: z.number(),
      size: z.string().optional(),
      image: ImageRefSchema.optional(),
      rootVolumeGB: z.number().optional(),
      rootVolumeType: z.string().optional(),
    }),
  ),
});
export type InfraSummary = z.infer<typeof InfraSummarySchema>;

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
      phase: z.string().optional(),
      conditions: z.array(ConditionSchema),
    }),
  ),
  machines: z.array(MachineStatusSchema),
  /** Bastion host (FP5-F-20): desired state from the spec, address from the provider. */
  bastion: z
    .object({
      enabled: z.boolean(),
      allowedCidrs: z.array(z.string()).optional(),
      machineSize: z.string().optional(),
      publicIP: z.string().optional(),
      privateIP: z.string().optional(),
      state: z.string().optional(),
      /** SSH open to everyone (CAPO); the UI warns. */
      openToAll: z.boolean(),
    })
    .optional(),
  /** Infrastructure card: facts and machine groups (managed clusters only). */
  infraSummary: InfraSummarySchema.optional(),
  /** Newest first, at most EVENT_LIMIT (FP6-F-02). */
  events: z.array(ClusterEventSchema),
  /** Kubeconfig Secret exists (FP6-F-04). */
  kubeconfigAvailable: z.boolean(),
});
export type ClusterStatus = z.infer<typeof ClusterStatusSchema>;

export const EVENT_LIMIT = 50;

// ---- deletion (FP6-F-06) ----

export const DeleteRequestSchema = z.object({
  /** Must equal the cluster name (FP6-F-06). */
  confirmName: z.string(),
  /** Remove workloads, LoadBalancer services and volumes inside the cluster first. */
  cleanup: z.boolean().default(true),
  /**
   * Delete machines without draining their nodes or waiting for volume detach (CAPI
   * exclude-node-draining annotations); for clusters whose API no longer answers.
   */
  skipDrain: z.boolean().default(false),
});
export type DeleteRequest = z.input<typeof DeleteRequestSchema>;

/** What a deletion removes (shown before confirming, hard rule 6). */
export const DeletePreviewSchema = z.object({
  managed: z.boolean(),
  /** The workload cluster API answered; otherwise no cleanup is possible. */
  workloadReachable: z.boolean(),
  namespaces: z.array(z.string()),
  loadBalancers: z.array(z.string()),
  volumes: z.array(z.string()),
  /** Volumes with reclaim policy Retain stay in the cloud. */
  retainedVolumes: z.array(z.string()),
  objects: z.array(z.object({ kind: z.string(), name: z.string() })),
  warnings: z.array(z.string()),
});
export type DeletePreview = z.infer<typeof DeletePreviewSchema>;
