import { z } from 'zod';
import { ConditionSchema } from '../cluster/api.js';
import { AddonSpecSchema } from './addon.js';
import { ManifestAddonSpecSchema } from './manifest-addon.js';

/** Helm add-ons of the app's chart browser, or manifest add-ons (FP-30). */
export const ADDON_TYPES = ['helm', 'manifests'] as const;

/** Release of an add-on on one cluster (HelmReleaseProxy, FP8-F-11). */
export const HelmReleaseStatusSchema = z.object({
  name: z.string(),
  cluster: z.string(),
  releaseName: z.string().optional(),
  releaseNamespace: z.string().optional(),
  chartVersion: z.string().optional(),
  revision: z.number().optional(),
  status: z.string().optional(),
  ready: z.boolean(),
  conditions: z.array(ConditionSchema),
});
export type HelmReleaseStatus = z.infer<typeof HelmReleaseStatusSchema>;

export const AddonStatusSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  /** Created by the app; others are read-only in the UI. */
  managed: z.boolean(),
  presetId: z.string().optional(),
  repository: z.string().optional(),
  type: z.enum(ADDON_TYPES),
  /** Form model, when the HelmChartProxy fits the form. */
  spec: AddonSpecSchema.optional(),
  /** Form model of a manifest add-on (FP-30). */
  manifestSpec: ManifestAddonSpecSchema.optional(),
  chartName: z.string(),
  repoURL: z.string(),
  version: z.string().optional(),
  releaseName: z.string().optional(),
  releaseNamespace: z.string().optional(),
  reconcileStrategy: z.string().optional(),
  clusterSelector: z.object({
    matchLabels: z.record(z.string(), z.string()).optional(),
    matchExpressions: z.array(z.unknown()).optional(),
  }),
  matchingClusters: z.array(z.string()),
  ready: z.boolean(),
  conditions: z.array(ConditionSchema),
  releases: z.array(HelmReleaseStatusSchema),
  createdAt: z.string().optional(),
});
export type AddonStatus = z.infer<typeof AddonStatusSchema>;

/** CAAPH availability (FP8-F-01). */
export const CaaphStatusSchema = z.object({
  installed: z.boolean(),
  ready: z.boolean(),
  version: z.string().optional(),
  message: z.string().optional(),
});
export type CaaphStatus = z.infer<typeof CaaphStatusSchema>;

export const AddonOverviewSchema = z.object({
  caaph: CaaphStatusSchema,
  addons: z.array(AddonStatusSchema),
});
export type AddonOverview = z.infer<typeof AddonOverviewSchema>;
