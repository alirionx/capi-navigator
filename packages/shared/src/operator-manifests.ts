import { stringify } from 'yaml';
import { OPERATOR_API_VERSION, type ProviderCatalogEntry } from './catalog/providers.js';
import { shortHash } from './cluster/util.js';
import type { ProviderInstallSpec } from './operator.js';

/** Minimal Kubernetes object shape used by the pure manifest builders. */
export interface ManifestObject {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  [key: string]: unknown;
}

/** Neutral label on objects created by the app (POS-03). */
export const MANAGED_BY_LABEL = 'capi-navigator.io/managed-by';
export const MANAGED_BY_VALUE = 'capi-navigator';

export function providerConfigSecretName(entry: ProviderCatalogEntry): string {
  return `${entry.name}-${entry.kind.replace(/Provider$/, '').toLowerCase()}-variables`;
}

function sorted<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Builds the objects that install a provider through the CAPI Operator: namespace, optional
 * configuration Secret and the provider CR (FP3-F-09). Pure and deterministic (hard rule 3).
 */
export function buildProviderManifests(
  entry: ProviderCatalogEntry,
  spec: ProviderInstallSpec,
  /** CA certificates (PEM) of the stored credentials, for providers with `tls` (FP31-F-01). */
  opts: { caBundle?: string } = {},
): ManifestObject[] {
  const labels = { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE };
  const objects: ManifestObject[] = [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: spec.namespace, labels } },
  ];
  const hasVariables = Object.keys(spec.variables).length > 0;
  const secretName = providerConfigSecretName(entry);
  if (hasVariables) {
    objects.push({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: secretName, namespace: spec.namespace, labels },
      type: 'Opaque',
      stringData: sorted(spec.variables),
    });
  }
  const providerSpec: Record<string, unknown> = { version: spec.version };
  if (hasVariables) providerSpec.configSecret = { name: secretName, namespace: spec.namespace };
  if (Object.keys(spec.featureGates).length > 0) {
    providerSpec.manager = { featureGates: sorted(spec.featureGates) };
  }
  if (spec.fetchConfigUrl) providerSpec.fetchConfig = { url: spec.fetchConfigUrl };
  if (entry.tls) Object.assign(providerSpec, tlsSettings(entry, entry.tls, opts.caBundle, objects));
  objects.push({
    apiVersion: OPERATOR_API_VERSION,
    kind: entry.kind,
    metadata: { name: entry.name, namespace: spec.namespace, labels },
    spec: providerSpec,
  });
  return objects;
}

/**
 * TLS verification of the infrastructure API (FP31-F-01): the provider's insecure default is
 * switched off; with CAs, the bundle is mounted from a Secret and passed to the manager. Its hash
 * is part of the environment, so a changed bundle restarts the manager.
 */
function tlsSettings(
  entry: ProviderCatalogEntry,
  tls: NonNullable<ProviderCatalogEntry['tls']>,
  caBundle: string | undefined,
  objects: ManifestObject[],
): Record<string, unknown> {
  const env = Object.entries(sorted(tls.env)).map(([name, value]) => ({ name, value }));
  if (!caBundle?.trim()) {
    return { deployment: { containers: [{ name: tls.container, env }] } };
  }
  const secretName = `${entry.name}-ca-bundle`;
  objects.push({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: secretName,
      namespace: objects[0]!.metadata.name,
      labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
    },
    type: 'Opaque',
    stringData: { 'ca.crt': caBundle },
  });
  return {
    deployment: {
      containers: [
        {
          name: tls.container,
          args: { [tls.certFileArg]: `${tls.mountPath}/ca.crt` },
          env: [...env, { name: 'CAPI_NAVIGATOR_CA_BUNDLE', value: shortHash(caBundle) }],
        },
      ],
    },
    // The operator's container settings cannot add volumes; a JSON patch appends them.
    patches: [
      {
        target: { kind: 'Deployment', name: tls.deployment },
        patch: stringify([
          {
            op: 'add',
            path: '/spec/template/spec/volumes/-',
            value: { name: 'capi-navigator-ca', secret: { secretName } },
          },
          {
            op: 'add',
            path: `/spec/template/spec/containers/${tls.containerIndex}/volumeMounts/-`,
            value: { name: 'capi-navigator-ca', mountPath: tls.mountPath, readOnly: true },
          },
        ]),
      },
    ],
  };
}

/** Renders objects as multi-document YAML; `maskSecrets` hides Secret values (NF-01). */
export function renderManifests(
  objects: ManifestObject[],
  opts: { maskSecrets?: boolean } = {},
): string {
  return objects
    .map((obj) => {
      if (opts.maskSecrets && obj.kind === 'Secret') {
        const mask = (data: unknown) =>
          data && typeof data === 'object'
            ? Object.fromEntries(Object.keys(data).map((k) => [k, '********']))
            : data;
        obj = {
          ...obj,
          ...(obj.stringData ? { stringData: mask(obj.stringData) } : {}),
          ...(obj.data ? { data: mask(obj.data) } : {}),
        };
      }
      return stringify(obj, { lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' });
    })
    .join('---\n');
}
