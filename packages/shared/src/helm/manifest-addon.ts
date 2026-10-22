import { parseAllDocuments } from 'yaml';
import { z } from 'zod';
import type { ManifestObject } from '../operator-manifests.js';
import {
  AddonSpecSchema,
  buildHelmChartProxy,
  HELM_REPOSITORY_ANNOTATION,
  type AddonRepositoryRef,
} from './addon.js';

/**
 * Manifest add-ons (FP-30, ADR-0024): plain manifests rolled out through CAAPH with the generic
 * chart deploy/helm/capi-navigator-manifests. One add-on is one HelmChartProxy; the manifests go
 * into its `valuesTemplate`, so CAAPH resolves Go templates in them per cluster.
 */
export const MANIFEST_CHART_NAME = 'capi-navigator-manifests';
/** Published by the release workflow with the app version (FP30-F-01). */
export const MANIFEST_CHART_DEFAULT_URL = 'oci://ghcr.io/alirionx/charts';
/** Marks the HelmChartProxy of a manifest add-on. */
export const ADDON_TYPE_LABEL = 'capi-navigator.io/addon-type';
export const MANIFESTS_ADDON_TYPE = 'manifests';
const MAX_MANIFESTS = 256 * 1024;

/** The objects of one manifest, as the checks see them. */
export interface ManifestObjectRef {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
}

/** Identity of an object for Helm: group, kind, namespace and name (the version does not count). */
export function manifestObjectKey(o: ManifestObjectRef): string {
  const group = o.apiVersion.includes('/') ? o.apiVersion.split('/')[0] : '';
  return `${group}/${o.kind}/${o.namespace ?? ''}/${o.name}`;
}

export function describeManifestObject(o: ManifestObjectRef): string {
  return `${o.kind} ${o.namespace ? `${o.namespace}/` : ''}${o.name}`;
}

/**
 * Pure: the objects of a manifest and what is wrong with it (FP30-F-05, FP30-F-06). CAAPH
 * template actions (`{{ … }}`) are replaced by distinct placeholders first, so templated values
 * and names pass; lines holding only an action (`{{- if … }}`) are dropped.
 */
export function checkManifests(manifests: string): {
  objects: ManifestObjectRef[];
  errors: string[];
} {
  let n = 0;
  const masked = manifests
    .replace(/\{\{[\s\S]*?\}\}/g, () => `tpl-${n++}`)
    .split('\n')
    .filter((line) => !/^\s*tpl-\d+\s*$/.test(line))
    .join('\n');
  const objects: ManifestObjectRef[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  parseAllDocuments(masked).forEach((doc, i) => {
    const at = `Document ${i + 1}`;
    if (doc.errors.length) {
      errors.push(`${at}: ${doc.errors[0]!.message.split('\n')[0]}`);
      return;
    }
    const value = doc.toJS() as unknown;
    if (value === null || value === undefined) return;
    const o = value as {
      apiVersion?: unknown;
      kind?: unknown;
      metadata?: { name?: unknown; namespace?: unknown };
    };
    if (typeof o !== 'object' || Array.isArray(o)) {
      errors.push(`${at}: not a Kubernetes object`);
      return;
    }
    if (typeof o.apiVersion !== 'string' || typeof o.kind !== 'string') {
      errors.push(`${at}: apiVersion and kind are required`);
      return;
    }
    if (typeof o.metadata?.name !== 'string' || !o.metadata.name) {
      errors.push(`${at}: metadata.name is required (generateName does not work with Helm)`);
      return;
    }
    const ref: ManifestObjectRef = {
      apiVersion: o.apiVersion,
      kind: o.kind,
      name: o.metadata.name,
      ...(typeof o.metadata.namespace === 'string' ? { namespace: o.metadata.namespace } : {}),
    };
    if (ref.apiVersion === 'v1' && ref.kind === 'Secret') {
      errors.push(
        `${at}: Secret ${ref.name} is not allowed: its content would be stored in plain text in the HelmChartProxy. Create Secrets with kubectl or an external secret operator instead.`,
      );
      return;
    }
    if (ref.kind.endsWith('List')) {
      errors.push(`${at}: ${ref.kind} is not supported; list the objects as separate documents`);
      return;
    }
    const key = manifestObjectKey(ref);
    if (seen.has(key)) {
      errors.push(`${at}: ${describeManifestObject(ref)} is listed twice`);
      return;
    }
    seen.add(key);
    objects.push(ref);
  });
  if (!errors.length && !objects.length) errors.push('At least one object is required');
  return { objects, errors };
}

/** Line endings and trailing blank lines normalized, so the round trip is exact. */
const normalize = (m: string) => `${m.replace(/\r\n?/g, '\n').trimEnd()}\n`;

const { name, namespace, releaseNamespace, clusterSelector, reconcileStrategy, options } =
  AddonSpecSchema.shape;

export const ManifestAddonSpecSchema = z.object({
  /** Also the Helm release name, which Helm limits to 53 characters. */
  name: name.max(53, 'At most 53 characters (Helm release name)'),
  namespace,
  /** Multi-document YAML; CAAPH Go templates allowed (FP30-F-07). */
  manifests: z
    .string()
    .max(MAX_MANIFESTS, 'At most 256 KiB')
    .transform(normalize)
    .superRefine((m, ctx) => {
      for (const message of checkManifests(m).errors) ctx.addIssue({ code: 'custom', message });
    }),
  /** Namespace of the Helm release; objects without a namespace are created there. */
  releaseNamespace,
  clusterSelector,
  reconcileStrategy,
  options,
});
export type ManifestAddonSpec = z.infer<typeof ManifestAddonSpecSchema>;
export type ManifestAddonSpecInput = z.input<typeof ManifestAddonSpecSchema>;

/**
 * Pure: the chart values. The manifests become one block scalar with a fixed indentation
 * indicator, so CAAPH can render templates anywhere in them; Helm then outputs them unchanged.
 */
export function manifestValuesTemplate(manifests: string): string {
  const body = normalize(manifests)
    .trimEnd()
    .split('\n')
    .map((line) => (line ? `  ${line}` : ''))
    .join('\n');
  return `manifests: |2\n${body}\n`;
}

/** Pure: the manifests back from the values, or undefined if they were changed outside the app. */
export function manifestsFromValuesTemplate(values: string): string | undefined {
  const m = /^manifests: \|2\n([\s\S]*)$/.exec(values);
  if (!m) return undefined;
  const lines = m[1]!.replace(/\n$/, '').split('\n');
  if (!lines.every((l) => l === '' || l.startsWith('  '))) return undefined;
  return normalize(lines.map((l) => l.slice(2)).join('\n'));
}

/** Where the chart comes from: a Helm repository of the app (FP30-F-02), or the default. */
export interface ManifestChartSource {
  /** Undefined: {@link MANIFEST_CHART_DEFAULT_URL} without credentials. */
  repository?: AddonRepositoryRef;
  version: string;
}

/** Repository reference of the default source; not a HelmRepository of the app. */
export const DEFAULT_MANIFEST_CHART_REPOSITORY: AddonRepositoryRef = {
  name: 'capi-navigator',
  type: 'oci',
  url: MANIFEST_CHART_DEFAULT_URL,
  insecureSkipTLSVerify: false,
  hasCredentials: false,
  hasCaCertificate: false,
};

/** Pure: the HelmChartProxy of a manifest add-on (FP30-F-04). */
export function buildManifestHelmChartProxy(
  spec: ManifestAddonSpec,
  source: ManifestChartSource,
): ManifestObject {
  const repo = source.repository ?? DEFAULT_MANIFEST_CHART_REPOSITORY;
  const hcp = buildHelmChartProxy(
    {
      ...spec,
      repository: repo.name,
      chartName: MANIFEST_CHART_NAME,
      version: source.version,
      releaseName: spec.name,
      valuesTemplate: manifestValuesTemplate(spec.manifests),
    },
    repo,
  );
  hcp.metadata.labels = { ...hcp.metadata.labels, [ADDON_TYPE_LABEL]: MANIFESTS_ADDON_TYPE };
  if (!source.repository) {
    const annotations = { ...hcp.metadata.annotations };
    delete annotations[HELM_REPOSITORY_ANNOTATION];
    if (Object.keys(annotations).length) hcp.metadata.annotations = annotations;
    else delete hcp.metadata.annotations;
  }
  return hcp;
}

interface HcpLike {
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  spec?: Record<string, unknown>;
}

export function isManifestAddon(hcp: HcpLike): boolean {
  return hcp.metadata.labels?.[ADDON_TYPE_LABEL] === MANIFESTS_ADDON_TYPE;
}

/** Pure: the form model of a manifest add-on, or undefined if it does not fit the form. */
export function manifestAddonSpecFromHelmChartProxy(hcp: HcpLike): ManifestAddonSpec | undefined {
  if (!isManifestAddon(hcp)) return undefined;
  const s = (hcp.spec ?? {}) as {
    clusterSelector?: { matchLabels?: Record<string, string>; matchExpressions?: unknown[] };
    chartName?: string;
    releaseName?: string;
    namespace?: string;
    valuesTemplate?: string;
    reconcileStrategy?: string;
    options?: { wait?: boolean; timeout?: string; install?: { createNamespace?: boolean } };
  };
  const manifests = manifestsFromValuesTemplate(s.valuesTemplate ?? '');
  if (
    manifests === undefined ||
    s.chartName !== MANIFEST_CHART_NAME ||
    s.releaseName !== hcp.metadata.name ||
    s.clusterSelector?.matchExpressions?.length
  ) {
    return undefined;
  }
  const parsed = ManifestAddonSpecSchema.safeParse({
    name: hcp.metadata.name,
    namespace: hcp.metadata.namespace,
    manifests,
    releaseNamespace: s.namespace || 'default',
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

/**
 * Two matchLabels selectors can select the same cluster when they agree on every key they share
 * (FP30-F-08).
 */
export function selectorsCanOverlap(a: Record<string, string>, b: Record<string, string>): boolean {
  return Object.entries(a).every(([k, v]) => !(k in b) || b[k] === v);
}

export const ManifestAddonApplyRequestSchema = z.object({
  spec: ManifestAddonSpecSchema,
  /** Take over fields changed outside the app (drift, hard rule 4). */
  takeOver: z.boolean().default(false),
});
export type ManifestAddonApplyRequest = z.input<typeof ManifestAddonApplyRequestSchema>;

/** Chart source of a connection and whether the needed version is there (FP30-F-02, F-03). */
export const ManifestChartStatusSchema = z.object({
  /** Helm repository of the app; unset: the default on ghcr.io. */
  repository: z.string().optional(),
  repositoryUrl: z.string(),
  chart: z.string(),
  /** Version the add-ons use: the app version, or the newest one at the source for dev builds. */
  version: z.string().optional(),
  available: z.boolean(),
  message: z.string().optional(),
  hint: z.string().optional(),
  /** Commands to mirror the chart into another registry. */
  mirrorCommands: z.string(),
});
export type ManifestChartStatus = z.infer<typeof ManifestChartStatusSchema>;

/** Pure: how to copy the chart of a version into a mirror (FP30-F-02). */
export function manifestChartMirrorCommands(version: string, target?: string): string {
  const file = `${MANIFEST_CHART_NAME}-${version}.tgz`;
  return [
    `helm pull ${MANIFEST_CHART_DEFAULT_URL}/${MANIFEST_CHART_NAME} --version ${version}`,
    `helm push ${file} ${target?.startsWith('oci://') ? target : 'oci://registry.example.com/charts'}`,
  ].join('\n');
}

/** Examples next to the editor (FP30-F-07). */
export const MANIFEST_EXAMPLES: { id: string; title: string; manifests: string }[] = [
  {
    id: 'cluster-issuer',
    title: 'cert-manager ClusterIssuer (Let’s Encrypt)',
    manifests: `# Needs cert-manager on the cluster (e.g. as Helm add-on). CAAPH renders
# {{ .Cluster.metadata.name }} per cluster.
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@example.com
    privateKeySecretRef:
      name: letsencrypt-account-{{ .Cluster.metadata.name }}
    solvers:
      - http01:
          gatewayHTTPRoute:
            parentRefs:
              - name: default
                namespace: gateway
`,
  },
  {
    id: 'gateway',
    title: 'Gateway API Gateway',
    manifests: `# Needs a Gateway API implementation (e.g. Envoy Gateway as Helm add-on) and its GatewayClass.
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: default
  namespace: gateway
spec:
  gatewayClassName: eg
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      hostname: "*.{{ .Cluster.metadata.name }}.example.com"
      allowedRoutes:
        namespaces:
          from: All
`,
  },
];
