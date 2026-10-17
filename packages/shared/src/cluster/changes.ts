import { z } from 'zod';
import {
  BastionSchema,
  ClusterSpecSchema,
  NodeCustomizationSchema,
  UserLabelsSchema,
  WorkerPoolSchema,
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
  change: z.enum(['create', 'update', 'delete']),
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

/** Machines a change replaces, per group, in rollout order (FP7-F-16). */
export const RolloutPlanSchema = z.object({
  order: z.number(),
  kind: z.string(),
  name: z.string(),
  group: z.string(),
  /** Machines that are replaced (or removed with a deleted pool). */
  machines: z.array(z.string()),
  /** Rolling update settings, e.g. "maxSurge 1, maxUnavailable 0". */
  strategy: z.string(),
  action: z.enum(['replace', 'remove', 'later']),
});
export type RolloutPlan = z.infer<typeof RolloutPlanSchema>;

export const ClusterChangePreviewSchema = z.object({
  diffs: z.array(ObjectDiffSchema),
  rollouts: z.array(RolloutPlanSchema).default([]),
  drift: z.array(DriftSchema),
  warnings: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type ClusterChangePreview = z.infer<typeof ClusterChangePreviewSchema>;

// ---- day-2 changes (FP-7) ----

/** Name of the control plane group in day-2 changes (pool names have at most 12 characters). */
export const CONTROL_PLANE_GROUP = 'control-plane';

/** Version parts for comparisons: "v1.35.9+rke2r1" → [1, 35, 9, 1]. */
export function versionParts(v: string): number[] {
  // The revision is the last number of the suffix: "+rke2r1" → 1, "+k0s.1" → 1.
  const m = /^v(\d+)\.(\d+)\.(\d+)\+.*?(\d+)?$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0)] : [0, 0, 0, 0];
}

export function compareKubernetesVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

/**
 * FP7-F-08: only upgrades, at most one minor version per step, same distribution. Returns the
 * reason when the target is not allowed.
 */
export function upgradeProblem(current: string, target: string): string | undefined {
  if (target.split('+')[1]?.replace(/\d+$/, '') !== current.split('+')[1]?.replace(/\d+$/, '')) {
    return 'The target belongs to another Kubernetes distribution';
  }
  if (compareKubernetesVersions(target, current) <= 0)
    return 'Only upgrades are possible (no downgrades)';
  const [, minorA] = versionParts(current);
  const [majorB, minorB] = versionParts(target);
  if (majorB !== versionParts(current)[0] || minorB! - minorA! > 1) {
    return 'At most one minor version per upgrade step';
  }
  return undefined;
}

const GroupSchema = z.string().min(1).max(64);
const RolloutSettingsSchema = z.object({
  maxSurge: z.int().min(0).max(10),
  maxUnavailable: z.int().min(0).max(10),
});

/** Every day-2 change of the stored spec (FP7-F-06 to F-18). */
export const SpecChangeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('scale'),
    pool: z.string().min(1),
    replicas: z.int().min(0).max(100),
  }),
  z.object({
    type: z.literal('scaleControlPlane'),
    replicas: z.union([z.literal(1), z.literal(3), z.literal(5)]),
  }),
  z.object({ type: z.literal('labels'), labels: UserLabelsSchema }),
  z.object({ type: z.literal('bastion'), bastion: BastionSchema }),
  z.object({ type: z.literal('addPool'), pool: WorkerPoolSchema }),
  z.object({ type: z.literal('removePool'), pool: z.string().min(1) }),
  z.object({
    type: z.literal('machine'),
    group: GroupSchema,
    machineSize: z.string().trim().min(1).max(255).optional(),
    image: z.string().trim().min(1).max(255).optional(),
    rootVolumeSizeGB: z.int().min(10).max(4000).optional(),
    rootVolumeType: z.string().trim().min(1).max(255).optional(),
  }),
  z.object({
    type: z.literal('customization'),
    group: GroupSchema,
    customization: NodeCustomizationSchema,
  }),
  z.object({ type: z.literal('rebuild'), group: GroupSchema }),
  z.object({
    type: z.literal('rolloutSettings'),
    pool: z.string().min(1).optional(),
    settings: RolloutSettingsSchema,
  }),
  z.object({ type: z.literal('upgrade'), version: z.string().min(1) }),
  /** FP7-F-19: no change; regenerate and compare, apply to take changes made outside back. */
  z.object({ type: z.literal('reapply') }),
]);
export type SpecChange = z.infer<typeof SpecChangeSchema>;
export type SpecChangeInput = z.input<typeof SpecChangeSchema>;

export const ChangeRequestSchema = z.object({
  change: SpecChangeSchema,
  takeOver: z.boolean().default(false),
});
export type ChangeRequest = z.input<typeof ChangeRequestSchema>;

type Group =
  ClusterSpec['topology']['controlPlane'] | ClusterSpec['topology']['workerPools'][number];

function updateGroup(spec: ClusterSpec, group: string, fn: (g: Group) => Group): ClusterSpec {
  if (group === CONTROL_PLANE_GROUP) {
    return {
      ...spec,
      topology: {
        ...spec.topology,
        controlPlane: fn(spec.topology.controlPlane) as ClusterSpec['topology']['controlPlane'],
      },
    };
  }
  if (!spec.topology.workerPools.some((p) => p.name === group)) {
    throw new SpecChangeError(`Group "${group}" does not exist`);
  }
  return {
    ...spec,
    topology: {
      ...spec.topology,
      workerPools: spec.topology.workerPools.map((p) =>
        p.name === group ? (fn(p) as typeof p) : p,
      ),
    },
  };
}

/** Applies one day-2 change to the stored spec; returns a new, validated spec. */
export function applySpecChange(spec: ClusterSpec, change: SpecChange, now: Date): ClusterSpec {
  let next: ClusterSpec;
  switch (change.type) {
    case 'reapply':
      return spec;
    case 'scale':
      return scalePool(spec, change.pool, change.replicas);
    case 'labels':
      return setLabels(spec, change.labels);
    case 'bastion':
      return setBastion(spec, change.bastion);
    case 'scaleControlPlane':
      if (spec.topology.mode === 'all-in-one' && change.replicas !== 1) {
        throw new SpecChangeError('An all-in-one cluster has exactly one control plane node');
      }
      next = updateGroup(spec, CONTROL_PLANE_GROUP, (g) => ({ ...g, replicas: change.replicas }));
      break;
    case 'addPool':
      if (spec.topology.mode === 'all-in-one') {
        throw new SpecChangeError('An all-in-one cluster has no worker pools');
      }
      if (spec.topology.workerPools.some((p) => p.name === change.pool.name)) {
        throw new SpecChangeError(`Pool "${change.pool.name}" already exists`);
      }
      next = {
        ...spec,
        topology: { ...spec.topology, workerPools: [...spec.topology.workerPools, change.pool] },
      };
      break;
    case 'removePool':
      if (!spec.topology.workerPools.some((p) => p.name === change.pool)) {
        throw new SpecChangeError(`Pool "${change.pool}" does not exist`);
      }
      if (spec.topology.workerPools.length === 1) {
        throw new SpecChangeError('The last worker pool cannot be removed');
      }
      next = {
        ...spec,
        topology: {
          ...spec.topology,
          workerPools: spec.topology.workerPools.filter((p) => p.name !== change.pool),
        },
      };
      break;
    case 'machine': {
      const fields = {
        machineSize: change.machineSize,
        image: change.image,
        rootVolumeSizeGB: change.rootVolumeSizeGB,
        rootVolumeType: change.rootVolumeType,
      };
      next = updateGroup(spec, change.group, (g) => {
        const out: Record<string, unknown> = { ...g };
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
        // An empty image override falls back to the cluster image.
        if (fields.image === '') delete out.image;
        return out as Group;
      });
      break;
    }
    case 'customization':
      next = updateGroup(spec, change.group, (g) => ({
        ...g,
        customization: change.customization,
      }));
      break;
    case 'rebuild':
      next = updateGroup(spec, change.group, (g) => ({
        ...g,
        rebuildRequestedAt: now.toISOString(),
      }));
      break;
    case 'rolloutSettings':
      next = change.pool
        ? updateGroup(spec, change.pool, (g) => ({ ...g, rollout: change.settings }))
        : { ...spec, rollout: { ...spec.rollout, ...change.settings } };
      break;
    case 'upgrade': {
      if (spec.kubernetes.workerVersion) {
        throw new SpecChangeError('An upgrade is still running; wait until the workers follow');
      }
      const problem = upgradeProblem(spec.kubernetes.version, change.version);
      if (problem) throw new SpecChangeError(problem);
      const hasWorkers = spec.topology.mode === 'standard' && spec.topology.workerPools.length > 0;
      next = {
        ...spec,
        kubernetes: {
          ...spec.kubernetes,
          version: change.version,
          // Workers stay on the old version until the control plane runs the new one.
          ...(hasWorkers ? { workerVersion: spec.kubernetes.version } : {}),
        },
      };
      break;
    }
  }
  return ClusterSpecSchema.parse(next);
}

/** Whether a change replaces machines (rollouts allowed one at a time, FP7-F-17). */
export function changeReplacesMachines(change: SpecChange): boolean {
  return ['machine', 'customization', 'rebuild', 'upgrade'].includes(change.type);
}
