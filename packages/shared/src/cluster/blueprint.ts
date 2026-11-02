import { z } from 'zod';
import { distributionCatalog } from '../catalog/kubernetes-versions.js';
import { ConnectionNameSchema } from '../connections.js';
import { ClusterSpecSchema, UserLabelsSchema, type ClusterSpec } from './spec.js';

/**
 * Cluster blueprints (FP-34, ADR-0035): a concrete, reviewed cluster spec plus a fixed list of
 * parameters that may vary within limits. Clusters are created from a blueprint through the API
 * without a preview per request; the blueprint is what was reviewed when it was saved.
 */

/** Annotation on the CAPI Cluster naming its blueprint (FP34-F-06). */
export const BLUEPRINT_ANNOTATION = 'capi-navigator.io/blueprint';

const VERSION_PATTERN = /^v\d+\.\d+\.\d+(\+[a-z0-9.]+)?$/;
const PoolNameSchema = z.string().min(1).max(12);

/** FP34-F-02: the only parameters a blueprint can offer. */
export const BlueprintParametersSchema = z.object({
  /** Number of workers per worker pool, between min and max. */
  workerCounts: z
    .array(
      z.object({
        pool: PoolNameSchema,
        min: z.int().min(0).max(100),
        max: z.int().min(0).max(100),
      }),
    )
    .max(10)
    .default([]),
  /** Machine size per worker pool, one of the choices (flavors, machine types, Proxmox sizes). */
  machineSizes: z
    .array(
      z.object({
        pool: PoolNameSchema,
        choices: z.array(z.string().trim().min(1).max(255)).min(1).max(20),
      }),
    )
    .max(10)
    .default([]),
  /** Kubernetes versions of the distribution; not offered for air-gapped clusters. */
  kubernetesVersions: z
    .array(z.string().regex(VERSION_PATTERN, 'A version like v1.35.9+rke2r1'))
    .min(1)
    .max(10)
    .optional(),
});
export type BlueprintParameters = z.output<typeof BlueprintParametersSchema>;

const blueprintFields = {
  displayName: z.string().trim().min(1, 'Required').max(60),
  description: z.string().max(500).default(''),
  /** Management cluster connection the clusters are created in. */
  connection: ConnectionNameSchema,
  parameters: BlueprintParametersSchema.default({ workerCounts: [], machineSizes: [] }),
};

/**
 * FP34-F-01: the blueprint as the API checks it. `cluster` is a complete cluster spec; its name
 * is the example used for the check when the blueprint is saved (FP34-F-04) and is replaced by
 * the requested name for every cluster.
 */
export const ClusterBlueprintSpecSchema = z
  .object({ ...blueprintFields, cluster: ClusterSpecSchema })
  .superRefine((bp, ctx) => {
    for (const issue of blueprintParameterIssues(bp.cluster, bp.parameters)) {
      ctx.addIssue({ code: 'custom', path: ['parameters', ...issue.path], message: issue.message });
    }
  });
export type ClusterBlueprintSpecInput = z.input<typeof ClusterBlueprintSpecSchema>;
export type ClusterBlueprintSpec = z.output<typeof ClusterBlueprintSpecSchema>;

/**
 * The same blueprint as stored in the CRD (STATE-02): the cluster spec is opaque there, because
 * its discriminated unions are no structural schema; the backend checks it with the schema above.
 */
export const ClusterBlueprintStorageSchema = z.object({
  ...blueprintFields,
  cluster: z.looseObject({}).meta({ 'x-kubernetes-preserve-unknown-fields': true }),
});
export type ClusterBlueprintStorage = z.infer<typeof ClusterBlueprintStorageSchema>;

/** Connection and namespace of a stored blueprint: the scope of creating from it (FP34-F-05). */
export function blueprintScope(spec: ClusterBlueprintStorage): {
  connection: string;
  namespace: string;
} {
  const namespace = (spec.cluster as { namespace?: unknown }).namespace;
  return {
    connection: spec.connection,
    namespace: typeof namespace === 'string' ? namespace : 'default',
  };
}

interface ParameterIssue {
  path: (string | number)[];
  message: string;
}

/** Parameters must fit the base spec: existing pools, defaults within the limits (FP34-F-02). */
function blueprintParameterIssues(
  spec: ClusterSpec,
  params: BlueprintParameters,
): ParameterIssue[] {
  const issues: ParameterIssue[] = [];
  const pools = new Map(spec.topology.workerPools.map((p) => [p.name, p]));
  const seen = (list: { pool: string }[], key: string) => {
    const names = new Set<string>();
    list.forEach((entry, i) => {
      if (!pools.has(entry.pool)) {
        issues.push({
          path: [key, i, 'pool'],
          message: `The cluster has no worker pool "${entry.pool}"`,
        });
      }
      if (names.has(entry.pool)) {
        issues.push({
          path: [key, i, 'pool'],
          message: `Worker pool "${entry.pool}" is listed twice`,
        });
      }
      names.add(entry.pool);
    });
  };
  seen(params.workerCounts, 'workerCounts');
  seen(params.machineSizes, 'machineSizes');

  params.workerCounts.forEach((p, i) => {
    const pool = pools.get(p.pool);
    if (p.min > p.max)
      issues.push({ path: ['workerCounts', i, 'max'], message: 'At least the minimum' });
    if (pool && (pool.replicas < p.min || pool.replicas > p.max)) {
      issues.push({
        path: ['workerCounts', i],
        message: `The pool's ${pool.replicas} workers must lie between minimum and maximum`,
      });
    }
  });
  params.machineSizes.forEach((p, i) => {
    const pool = pools.get(p.pool);
    if (new Set(p.choices).size !== p.choices.length) {
      issues.push({ path: ['machineSizes', i, 'choices'], message: 'Each size only once' });
    }
    if (pool && !p.choices.includes(pool.machineSize)) {
      issues.push({
        path: ['machineSizes', i, 'choices'],
        message: `The pool's size ${pool.machineSize} must be one of the choices`,
      });
    }
  });
  const versions = params.kubernetesVersions;
  if (versions) {
    if (spec.airGapped) {
      issues.push({
        path: ['kubernetesVersions'],
        message:
          'Air-gapped clusters cannot offer versions: their artifacts are pinned per version',
      });
    }
    if (new Set(versions).size !== versions.length) {
      issues.push({ path: ['kubernetesVersions'], message: 'Each version only once' });
    }
    if (!versions.includes(spec.kubernetes.version)) {
      issues.push({
        path: ['kubernetesVersions'],
        message: `The cluster's version ${spec.kubernetes.version} must be one of the choices`,
      });
    }
  }
  return issues;
}

/**
 * Versions of a blueprint that are not in the version catalog of its distribution (FP34-F-02).
 * Checked when a blueprint is saved, not when a cluster is created, so a later catalog update
 * does not break existing blueprints.
 */
export function versionsOutsideCatalog(bp: ClusterBlueprintSpec): string[] {
  const known = new Set(
    distributionCatalog(bp.cluster.kubernetes.flavor)?.versions.map((v) => v.version),
  );
  return (bp.parameters.kubernetesVersions ?? []).filter((v) => !known.has(v));
}

/**
 * FP34-F-03: the parameters of one blueprint as strict Zod schema with defaults from the base
 * spec. Its JSON Schema is the plan schema of a service broker; the same schema checks requests.
 */
export function blueprintParametersSchema(bp: ClusterBlueprintSpec) {
  const pools = new Map(bp.cluster.topology.workerPools.map((p) => [p.name, p]));
  const names = [
    ...new Set([...bp.parameters.workerCounts, ...bp.parameters.machineSizes].map((p) => p.pool)),
  ].sort();
  const poolShape: Record<string, z.ZodType> = {};
  for (const name of names) {
    const pool = pools.get(name)!;
    const fields: Record<string, z.ZodType> = {};
    const count = bp.parameters.workerCounts.find((p) => p.pool === name);
    if (count) {
      fields.replicas = z
        .int()
        .min(count.min)
        .max(count.max)
        .default(pool.replicas)
        .describe(`Number of workers in pool ${name}`);
    }
    const size = bp.parameters.machineSizes.find((p) => p.pool === name);
    if (size) {
      fields.machineSize = z
        .enum(size.choices as [string, ...string[]])
        .default(pool.machineSize)
        .describe(`Machine size of pool ${name}`);
    }
    poolShape[name] = z.strictObject(fields).default({});
  }
  const shape: Record<string, z.ZodType> = {};
  if (names.length > 0) {
    shape.workerPools = z.strictObject(poolShape).default({}).describe('Worker pools');
  }
  const versions = bp.parameters.kubernetesVersions;
  if (versions) {
    shape.kubernetesVersion = z
      .enum(versions as [string, ...string[]])
      .default(bp.cluster.kubernetes.version)
      .describe('Kubernetes version');
  }
  return z.strictObject(shape);
}

/** FP34-F-03: JSON Schema draft-04, as the Open Service Broker API expects for plan schemas. */
export function blueprintParametersJsonSchema(bp: ClusterBlueprintSpec): Record<string, unknown> {
  return z.toJSONSchema(blueprintParametersSchema(bp), {
    target: 'draft-4',
    io: 'input',
  }) as Record<string, unknown>;
}

/** FP34-F-05: request body for creating a cluster from a blueprint. */
export const BlueprintClusterRequestSchema = z.object({
  name: ClusterSpecSchema.shape.name,
  /** Checked against the blueprint's parameters (FP34-F-02). */
  parameters: z.record(z.string(), z.unknown()).default({}),
  /** In addition to the blueprint's labels, e.g. the instance ID of a service broker. */
  labels: UserLabelsSchema.optional(),
});
export type BlueprintClusterRequest = z.input<typeof BlueprintClusterRequestSchema>;

/**
 * FP34-F-05: builds the cluster spec from a blueprint and a request. Pure: the base spec with the
 * requested name, parameters and additional labels, checked like every cluster spec. Additional
 * labels may not change the blueprint's labels.
 */
export function blueprintToSpecSchema(blueprintName: string, bp: ClusterBlueprintSpec) {
  const baseLabels = bp.cluster.labels ?? {};
  return z
    .object({
      name: ClusterSpecSchema.shape.name,
      parameters: blueprintParametersSchema(bp).prefault({}),
      labels: UserLabelsSchema.optional(),
    })
    .superRefine((req, ctx) => {
      for (const [key, value] of Object.entries(req.labels ?? {})) {
        if (key in baseLabels && baseLabels[key] !== value) {
          ctx.addIssue({
            code: 'custom',
            path: ['labels', key],
            message: `The blueprint sets this label to "${baseLabels[key]}"`,
          });
        }
      }
    })
    .transform((req): z.input<typeof ClusterSpecSchema> => {
      const params = req.parameters as {
        workerPools?: Record<string, { replicas?: number; machineSize?: string }>;
        kubernetesVersion?: string;
      };
      const spec = structuredClone(bp.cluster);
      spec.name = req.name;
      spec.blueprint = blueprintName;
      if (req.labels && Object.keys(req.labels).length > 0) {
        spec.labels = { ...req.labels, ...baseLabels };
      }
      if (params.kubernetesVersion) spec.kubernetes.version = params.kubernetesVersion;
      for (const pool of spec.topology.workerPools) {
        const p = params.workerPools?.[pool.name];
        if (p?.replicas !== undefined) pool.replicas = p.replicas;
        if (p?.machineSize !== undefined) pool.machineSize = p.machineSize;
      }
      return spec;
    })
    .pipe(ClusterSpecSchema);
}

/** Name of a blueprint: a DNS label, also the name of its `ClusterBlueprint` resource. */
export const BlueprintNameSchema = z
  .string()
  .min(2, 'At least 2 characters')
  .max(63, 'At most 63 characters')
  .regex(
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
    'Lowercase letters, digits and "-" only; must start and end with a letter or digit',
  );

/** FP34-F-04: saving (and previewing) a blueprint. */
export const BlueprintSaveRequestSchema = z.object({
  name: BlueprintNameSchema,
  spec: ClusterBlueprintSpecSchema,
});
export type BlueprintSaveRequest = z.input<typeof BlueprintSaveRequestSchema>;

/** A blueprint as the API returns it, with the JSON Schema of its parameters (FP34-F-03). */
export const ClusterBlueprintSchema = z.object({
  name: z.string(),
  spec: ClusterBlueprintSpecSchema,
  parametersSchema: z.record(z.string(), z.unknown()),
});
export type ClusterBlueprint = z.infer<typeof ClusterBlueprintSchema>;
