import { z } from 'zod';
import { ProviderKindSchema } from './catalog/providers.js';

/** State of a prerequisite on a management cluster (FP3-F-01, FP3-F-02, FP3-F-04a). */
export const ComponentStatusSchema = z.object({
  installed: z.boolean(),
  ready: z.boolean(),
  version: z.string().optional(),
  namespace: z.string().optional(),
  /** Why it is not ready, in understandable words. */
  message: z.string().optional(),
});
export type ComponentStatus = z.infer<typeof ComponentStatusSchema>;

export const PrerequisitesSchema = z.object({
  certManager: ComponentStatusSchema,
  operator: ComponentStatusSchema,
  orc: ComponentStatusSchema,
  /** FP3-F-03: install commands for missing components, with verified versions. */
  instructions: z.object({
    certManager: z.string(),
    operator: z.string(),
    orc: z.string(),
  }),
});
export type Prerequisites = z.infer<typeof PrerequisitesSchema>;

export const ProviderConditionSchema = z.object({
  type: z.string(),
  status: z.string(),
  reason: z.string().optional(),
  message: z.string().optional(),
  lastTransitionTime: z.string().optional(),
});
export type ProviderCondition = z.infer<typeof ProviderConditionSchema>;

/** An installed provider CR (FP3-F-08). */
export const InstalledProviderSchema = z.object({
  kind: ProviderKindSchema,
  name: z.string(),
  namespace: z.string(),
  /** Catalog entry, if the provider is known. */
  catalogId: z.string().optional(),
  /** Desired version (spec.version). */
  version: z.string().optional(),
  /** Version the operator reports as installed. */
  installedVersion: z.string().optional(),
  phase: z.enum(['Installing', 'Upgrading', 'Ready', 'Failed', 'Deleting']),
  conditions: z.array(ProviderConditionSchema),
  configSecret: z.object({ name: z.string(), namespace: z.string().optional() }).optional(),
  /** Names of the configuration variables (values are never returned, NF-01). */
  variableNames: z.array(z.string()).optional(),
  featureGates: z.record(z.string(), z.boolean()).optional(),
  fetchConfigUrl: z.string().optional(),
});
export type InstalledProvider = z.infer<typeof InstalledProviderSchema>;

export const OperatorStateSchema = z.object({
  prerequisites: PrerequisitesSchema,
  providers: z.array(InstalledProviderSchema),
});
export type OperatorState = z.infer<typeof OperatorStateSchema>;

const VariablesSchema = () =>
  z.record(
    z
      .string()
      .regex(
        /^[A-Z_][A-Z0-9_]*$/,
        'Upper case letters, digits and "_" only, e.g. EXP_CLUSTER_RESOURCE_SET',
      ),
    z.string().max(64 * 1024),
  );

/** FP3-F-09: install a provider through the CAPI Operator. */
export const ProviderInstallRequestSchema = z.object({
  catalogId: z.string().min(1),
  version: z.string().regex(/^v\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/, 'Version like v1.2.3'),
  namespace: z
    .string()
    .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'Must be a valid namespace name')
    .max(63),
  /** Configuration variables, stored in a Secret referenced by spec.configSecret. */
  variables: VariablesSchema().default({}),
  /** spec.manager.featureGates */
  featureGates: z.record(z.string().regex(/^[A-Za-z0-9]+$/), z.boolean()).default({}),
  /** Optional spec.fetchConfig.url for providers outside the built-in list. */
  fetchConfigUrl: z.url({ protocol: /^https$/ }).optional(),
});
export type ProviderInstallRequest = z.input<typeof ProviderInstallRequestSchema>;
export type ProviderInstallSpec = z.output<typeof ProviderInstallRequestSchema>;

/** FP3-F-12: change version or configuration of an installed provider. */
export const ProviderUpdateRequestSchema = z.object({
  version: ProviderInstallRequestSchema.shape.version,
  /** Full set of variables; omit to keep the stored ones (no default on purpose). */
  variables: VariablesSchema().optional(),
  featureGates: ProviderInstallRequestSchema.shape.featureGates,
});
export type ProviderUpdateRequest = z.input<typeof ProviderUpdateRequestSchema>;

export const OrcInstallRequestSchema = z.object({
  version: ProviderInstallRequestSchema.shape.version,
});
export type OrcInstallRequest = z.infer<typeof OrcInstallRequestSchema>;

/** Preview of what will be applied (FP3-F-10, NF-07). Secret values are masked. */
export const ManifestPreviewSchema = z.object({
  yaml: z.string(),
  objects: z.array(
    z.object({ kind: z.string(), name: z.string(), namespace: z.string().optional() }),
  ),
  /** Hints such as dependencies or the ORC version matching CAPO. */
  warnings: z.array(z.string()),
});
export type ManifestPreview = z.infer<typeof ManifestPreviewSchema>;

export const ReleaseListSchema = z.object({
  versions: z.array(z.string()),
  /** False when GitHub was not reachable and only the catalog version is offered. */
  live: z.boolean(),
});
export type ReleaseList = z.infer<typeof ReleaseListSchema>;

/** Workload clusters that still use a provider (FP3-F-12 removal warning). */
export const ProviderUsageSchema = z.object({
  clusters: z.array(z.object({ name: z.string(), namespace: z.string() })),
});
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;
