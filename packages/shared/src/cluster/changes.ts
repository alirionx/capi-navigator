import { z } from 'zod';
import {
  BastionSchema,
  ClusterSpecSchema,
  UserLabelsSchema,
  type Bastion,
  type ClusterSpec,
} from './spec.js';

/**
 * Day-to-day changes of a stored cluster spec (FP-6): pure functions that return a new, validated
 * spec. The backend regenerates the manifests from it and applies only what changed (hard rule 4).
 */

/** FP6-F-05: scale one worker pool. */
export const ScaleRequestSchema = z.object({
  pool: z.string().min(1),
  replicas: z.int().min(0).max(100),
  /** Take over fields that were changed outside the app (drift), after confirmation. */
  takeOver: z.boolean().default(false),
});
export type ScaleRequest = z.input<typeof ScaleRequestSchema>;

/** FP6-F-07: replace the user labels of the cluster. */
export const LabelsRequestSchema = z.object({
  labels: UserLabelsSchema,
  takeOver: z.boolean().default(false),
});
export type LabelsRequest = z.input<typeof LabelsRequestSchema>;

export class SpecChangeError extends Error {}

export function scalePool(spec: ClusterSpec, pool: string, replicas: number): ClusterSpec {
  if (spec.topology.mode === 'all-in-one') {
    throw new SpecChangeError('An all-in-one cluster has no worker pools to scale');
  }
  if (!spec.topology.workerPools.some((p) => p.name === pool)) {
    throw new SpecChangeError(`Worker pool "${pool}" does not exist`);
  }
  return ClusterSpecSchema.parse({
    ...spec,
    topology: {
      ...spec.topology,
      workerPools: spec.topology.workerPools.map((p) => (p.name === pool ? { ...p, replicas } : p)),
    },
  });
}

export function setLabels(spec: ClusterSpec, labels: Record<string, string>): ClusterSpec {
  const next: Record<string, unknown> = { ...spec };
  delete next.labels;
  if (Object.keys(labels).length > 0) next.labels = labels;
  return ClusterSpecSchema.parse(next);
}

/** FP5-F-20: enable, disable or reconfigure the bastion host. */
export const BastionRequestSchema = z.object({
  bastion: BastionSchema,
  takeOver: z.boolean().default(false),
});
export type BastionRequest = z.input<typeof BastionRequestSchema>;

export function setBastion(spec: ClusterSpec, bastion: Bastion): ClusterSpec {
  const current = spec.infrastructure.bastion;
  if (
    current?.enabled &&
    bastion.enabled &&
    (current.machineSize !== bastion.machineSize || current.image !== bastion.image)
  ) {
    // Neither CAPO nor CAPA change a running bastion; it is replaced via disable and enable.
    throw new SpecChangeError('Disable the bastion first to change its size or image');
  }
  return ClusterSpecSchema.parse({
    ...spec,
    infrastructure: {
      ...spec.infrastructure,
      bastion: {
        ...bastion,
        // CAPO needs the bastion spec (flavor) also while disabling.
        machineSize: bastion.machineSize ?? current?.machineSize,
      },
    },
  });
}

/** One object of a change preview, as YAML before and after (Secret values masked). */
export const ObjectDiffSchema = z.object({
  kind: z.string(),
  name: z.string(),
  namespace: z.string().optional(),
  change: z.enum(['create', 'update']),
  before: z.string(),
  after: z.string(),
});
export type ObjectDiff = z.infer<typeof ObjectDiffSchema>;

/** Fields another field manager owns (changed outside the app, hard rule 4). */
export const DriftSchema = z.object({
  kind: z.string(),
  name: z.string(),
  managers: z.array(z.string()),
  fields: z.array(z.string()),
  /** The change needs this object; applying requires taking the fields over. */
  blocking: z.boolean(),
});
export type Drift = z.infer<typeof DriftSchema>;

export const ClusterChangePreviewSchema = z.object({
  diffs: z.array(ObjectDiffSchema),
  drift: z.array(DriftSchema),
  warnings: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type ClusterChangePreview = z.infer<typeof ClusterChangePreviewSchema>;
