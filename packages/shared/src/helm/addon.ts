import { z } from 'zod';
import { DriftSchema, ObjectDiffSchema } from '../cluster/changes.js';
import { LabelsSchema } from '../cluster/spec.js';
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE, type ManifestObject } from '../operator-manifests.js';
import {
  helmRepositoryCopyName,
  HelmRepositoryNameSchema,
  type HelmRepositoryType,
} from './repository.js';

/**
 * Helm add-ons (FP-8) as CAAPH HelmChartProxies (addons.cluster.x-k8s.io/v1alpha1, verified
 * against CAAPH v0.6.4 CRDs on 2026-10-18). The HelmChartProxy itself is the source of truth:
 * the form model below maps 1:1 onto it, plus the repository name as an annotation.
 * A HelmChartProxy selects clusters in its own namespace only.
 */
export const HELM_ADDON_API_VERSION = 'addons.cluster.x-k8s.io/v1alpha1';
export const HELM_REPOSITORY_ANNOTATION = 'capi-navigator.io/helm-repository';
export const PRESET_LABEL = 'capi-navigator.io/preset';
/** Label CAAPH sets on each HelmReleaseProxy. */
export const HELM_CHART_PROXY_NAME_LABEL =
  'helmreleaseproxy.addons.cluster.x-k8s.io/helmchartproxy-name';
export const RECONCILE_STRATEGIES = ['Continuous', 'InstallOnce'] as const;

const K8sNameSchema = z
  .string()
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'Lowercase letters, digits and "-" only');

/** Go duration as Helm expects it, e.g. 10m0s or 5m. */
const DurationSchema = z.string().regex(/^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/, 'e.g. 10m or 90s');

export const AddonSpecSchema = z.object({
  name: K8sNameSchema.refine(
    (n) => !n.startsWith('capi-navigator-'),
    'Names starting with "capi-navigator-" are reserved for presets',
  ),
  /** Namespace of the HelmChartProxy; it selects clusters in this namespace only. */
  namespace: K8sNameSchema,
  repository: HelmRepositoryNameSchema,
  chartName: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'A chart name'),
  version: z.string().trim().min(1, 'Pin a chart version').max(128),
  /** Defaults to the chart name. */
  releaseName: K8sNameSchema.max(53).optional(),
  releaseNamespace: K8sNameSchema.default('default'),
  /** CAAPH Go template, e.g. `{{ .Cluster.metadata.name }}` (FP8-F-06). */
  valuesTemplate: z
    .string()
    .max(256 * 1024)
    .default(''),
  /** matchLabels of the cluster selector (FP8-F-07); at least one, an empty one matches all. */
  clusterSelector: LabelsSchema.refine(
    (l) => Object.keys(l).length > 0,
    'At least one label; an empty selector would select every cluster in the namespace',
  ),
  /** FP8-F-09; immutable in CAAPH. */
  reconcileStrategy: z.enum(RECONCILE_STRATEGIES).default('Continuous'),
  options: z
    .object({
      wait: z.boolean().default(true),
      timeout: DurationSchema.default('10m0s'),
      createNamespace: z.boolean().default(true),
    })
    .default({ wait: true, timeout: '10m0s', createNamespace: true }),
});
export type AddonSpec = z.infer<typeof AddonSpecSchema>;
export type AddonSpecInput = z.input<typeof AddonSpecSchema>;

/** What the builder needs to know about the repository. */
export interface AddonRepositoryRef {
  name: string;
  type: HelmRepositoryType;
  url: string;
  insecureSkipTLSVerify: boolean;
  hasCredentials: boolean;
  hasCaCertificate: boolean;
}

/** Example shown next to the values editor (FP8-F-06). */
export const VALUES_TEMPLATE_EXAMPLE = `# CAAPH renders this per cluster (Go templates):
#   {{ .Cluster.metadata.name }}       name of the workload cluster
#   {{ .Cluster.metadata.namespace }}  its namespace
#   {{ .Cluster.metadata.labels.env }} a cluster label
#   {{ .ControlPlane.spec.version }}   the control plane object
#   {{ .InfraCluster.spec.region }}    the infrastructure cluster (e.g. AWSCluster)
ui:
  message: "Hello from {{ .Cluster.metadata.name }}"
`;

/** Pure: the HelmChartProxy of an add-on (FP8-F-05, FP8-F-10). */
export function buildHelmChartProxy(spec: AddonSpec, repo: AddonRepositoryRef): ManifestObject {
  const oci = repo.type === 'oci';
  const copy = helmRepositoryCopyName(repo.name);
  const tlsConfig = {
    ...(oci && repo.hasCaCertificate
      ? { caSecret: { name: copy, namespace: spec.namespace } }
      : {}),
    ...(oci && repo.insecureSkipTLSVerify ? { insecureSkipTLSVerify: true } : {}),
  };
  return {
    apiVersion: HELM_ADDON_API_VERSION,
    kind: 'HelmChartProxy',
    metadata: {
      name: spec.name,
      namespace: spec.namespace,
      labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
      annotations: { [HELM_REPOSITORY_ANNOTATION]: repo.name },
    },
    spec: {
      clusterSelector: { matchLabels: { ...spec.clusterSelector } },
      repoURL: repo.url,
      chartName: spec.chartName,
      version: spec.version,
      releaseName: spec.releaseName ?? spec.chartName,
      namespace: spec.releaseNamespace,
      valuesTemplate: spec.valuesTemplate,
      reconcileStrategy: spec.reconcileStrategy,
      options: {
        wait: spec.options.wait,
        timeout: spec.options.timeout,
        install: { createNamespace: spec.options.createNamespace },
      },
      ...(oci && repo.hasCredentials
        ? { credentials: { secret: { name: copy, namespace: spec.namespace }, key: 'config.json' } }
        : {}),
      ...(Object.keys(tlsConfig).length ? { tlsConfig } : {}),
    },
  };
}

/**
 * Pure: the copy of the repository Secret in the add-on's namespace (keys `config.json` and
 * `ca.crt`, as CAAPH expects them). Holds the registry password; never shown in previews unmasked.
 */
export function buildRepositorySecretCopy(
  repository: string,
  namespace: string,
  data: { configJson?: string; caCrt?: string },
): ManifestObject {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: helmRepositoryCopyName(repository),
      namespace,
      labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
      annotations: { [HELM_REPOSITORY_ANNOTATION]: repository },
    },
    type: 'Opaque',
    stringData: {
      ...(data.configJson ? { 'config.json': data.configJson } : {}),
      ...(data.caCrt ? { 'ca.crt': data.caCrt } : {}),
    },
  };
}

interface HcpLike {
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: Record<string, unknown>;
}

/** Pure: the form model of an existing HelmChartProxy, or undefined if it does not fit the form. */
export function addonSpecFromHelmChartProxy(hcp: HcpLike): AddonSpec | undefined {
  const s = (hcp.spec ?? {}) as {
    clusterSelector?: { matchLabels?: Record<string, string>; matchExpressions?: unknown[] };
    chartName?: string;
    version?: string;
    releaseName?: string;
    namespace?: string;
    valuesTemplate?: string;
    reconcileStrategy?: string;
    options?: { wait?: boolean; timeout?: string; install?: { createNamespace?: boolean } };
  };
  if (s.clusterSelector?.matchExpressions?.length) return undefined;
  const parsed = AddonSpecSchema.safeParse({
    name: hcp.metadata.name,
    namespace: hcp.metadata.namespace,
    repository: hcp.metadata.annotations?.[HELM_REPOSITORY_ANNOTATION],
    chartName: s.chartName,
    version: s.version,
    releaseName: s.releaseName,
    releaseNamespace: s.namespace || 'default',
    valuesTemplate: s.valuesTemplate ?? '',
    clusterSelector: s.clusterSelector?.matchLabels ?? {},
    reconcileStrategy: s.reconcileStrategy || 'Continuous',
    options: {
      wait: s.options?.wait ?? false,
      timeout: s.options?.timeout ?? '10m0s',
      createNamespace: s.options?.install?.createNamespace ?? true,
    },
  });
  return parsed.success ? parsed.data : undefined;
}

export const AddonApplyRequestSchema = z.object({
  spec: AddonSpecSchema,
  /** Take over fields changed outside the app (drift, hard rule 4). */
  takeOver: z.boolean().default(false),
});
export type AddonApplyRequest = z.input<typeof AddonApplyRequestSchema>;

/** Preview before apply (FP8-F-10, hard rule 6). */
export const AddonPreviewSchema = z.object({
  diffs: z.array(ObjectDiffSchema),
  drift: z.array(DriftSchema),
  matchingClusters: z.array(z.string()),
  warnings: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type AddonPreview = z.infer<typeof AddonPreviewSchema>;

/** What deleting a HelmChartProxy does (FP8-F-13). */
export const AddonDeletePreviewSchema = z.object({
  releases: z.array(z.object({ cluster: z.string(), releaseName: z.string().optional() })),
  /** InstallOnce releases stay installed (CAAPH does not uninstall them). */
  uninstalls: z.boolean(),
  warnings: z.array(z.string()),
  yaml: z.string(),
});
export type AddonDeletePreview = z.infer<typeof AddonDeletePreviewSchema>;

/** Clusters of a namespace a selector matches (FP8-F-07, live while typing). */
export function matchesSelector(
  clusterLabels: Record<string, string>,
  selector: Record<string, string>,
): boolean {
  const entries = Object.entries(selector);
  return entries.length > 0 && entries.every(([k, v]) => clusterLabels[k] === v);
}
