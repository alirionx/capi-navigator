import { stringify } from 'yaml';
import { OPERATOR_API_VERSION, type ProviderCatalogEntry } from './catalog/providers.js';
import { shortHash } from './cluster/util.js';
import type { OutboundProxy } from './connections.js';
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

/** Annotation on provider CRs that use the outbound proxy: hash of its settings (FP-29). */
export const OUTBOUND_PROXY_ANNOTATION = 'capi-navigator.io/outbound-proxy';
const PROXY_CA_MOUNT = '/etc/capi-navigator/proxy-ca';
/** Secret with the proxy CA in the provider's namespace. */
export const PROXY_CA_SECRET = 'capi-navigator-proxy-ca';

/** Outbound proxy for a provider controller (FP-29). */
export interface ProviderProxyOptions {
  settings: OutboundProxy;
  /** ClusterIP of the `kubernetes` Service: client-go would send its own API calls to the proxy. */
  apiServerIp?: string;
}

/** Hash of the proxy settings; compared with the annotation to find outdated providers. */
export function outboundProxyHash(settings: OutboundProxy): string {
  return shortHash(settings);
}

/** NO_PROXY of the controllers: in-cluster names and the API server first, then the user's list. */
export function effectiveNoProxy(noProxy: string | undefined, apiServerIp?: string): string {
  const entries = [
    'localhost',
    '127.0.0.1',
    '.svc',
    '.cluster.local',
    ...(apiServerIp ? [apiServerIp] : []),
    ...(noProxy ?? '').split(','),
  ]
    .map((e) => e.trim())
    .filter(Boolean);
  return [...new Set(entries)].join(',');
}

interface ContainerSettings {
  name: string;
  args?: Record<string, string>;
  env: { name: string; value: string }[];
}
interface Patch {
  target: { kind: string; name?: string };
  patch: string;
}

/**
 * Builds the objects that install a provider through the CAPI Operator: namespace, optional
 * configuration Secret and the provider CR (FP3-F-09). Pure and deterministic (hard rule 3).
 */
export function buildProviderManifests(
  entry: ProviderCatalogEntry,
  spec: ProviderInstallSpec,
  opts: {
    /** CA certificates (PEM) of the stored credentials, for providers with `tls` (FP31-F-01). */
    caBundle?: string;
    /** Outbound proxy of the management cluster (FP-29). */
    outboundProxy?: ProviderProxyOptions;
  } = {},
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

  // The operator's container settings cannot add volumes; JSON patches append them.
  const container: ContainerSettings = { name: entry.tls?.container ?? 'manager', env: [] };
  const patches: Patch[] = [];
  if (entry.tls) tlsSettings(entry, entry.tls, opts.caBundle, objects, container, patches);
  const metadata: ManifestObject['metadata'] = {
    name: entry.name,
    namespace: spec.namespace,
    labels,
  };
  if (opts.outboundProxy) {
    proxySettings(entry, opts.outboundProxy, objects, container, patches);
    metadata.annotations = {
      [OUTBOUND_PROXY_ANNOTATION]: outboundProxyHash(opts.outboundProxy.settings),
    };
  }
  if (container.env.length > 0 || container.args) {
    // Key order as before FP-29, so existing providers see no change.
    const { name, args, env } = container;
    providerSpec.deployment = { containers: [{ name, ...(args ? { args } : {}), env }] };
  }
  if (patches.length > 0) providerSpec.patches = patches;
  objects.push({
    apiVersion: OPERATOR_API_VERSION,
    kind: entry.kind,
    metadata,
    spec: providerSpec,
  });
  return objects;
}

function caSecret(name: string, namespace: string, caBundle: string): ManifestObject {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace, labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE } },
    type: 'Opaque',
    stringData: { 'ca.crt': caBundle },
  };
}

function volumePatch(
  target: Patch['target'],
  containerIndex: number,
  volume: string,
  secretName: string,
  mountPath: string,
): Patch {
  return {
    target,
    patch: stringify([
      {
        op: 'add',
        path: '/spec/template/spec/volumes/-',
        value: { name: volume, secret: { secretName } },
      },
      {
        op: 'add',
        path: `/spec/template/spec/containers/${containerIndex}/volumeMounts/-`,
        value: { name: volume, mountPath, readOnly: true },
      },
    ]),
  };
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
  container: ContainerSettings,
  patches: Patch[],
): void {
  container.env.push(...Object.entries(sorted(tls.env)).map(([name, value]) => ({ name, value })));
  if (!caBundle?.trim()) return;
  const secretName = `${entry.name}-ca-bundle`;
  objects.push(caSecret(secretName, objects[0]!.metadata.name, caBundle));
  container.args = { [tls.certFileArg]: `${tls.mountPath}/ca.crt` };
  container.env.push({ name: 'CAPI_NAVIGATOR_CA_BUNDLE', value: shortHash(caBundle) });
  patches.push(
    volumePatch(
      { kind: 'Deployment', name: tls.deployment },
      tls.containerIndex,
      'capi-navigator-ca',
      secretName,
      tls.mountPath,
    ),
  );
}

/**
 * Outbound proxy (FP-29): the standard variables, which Go programs read. A proxy CA is mounted
 * and named in SSL_CERT_DIR, which Go reads in addition to the system trust store. The settings
 * hash in the environment restarts the controller when they change. Every provider's components
 * have one Deployment with the manager as first container.
 */
function proxySettings(
  entry: ProviderCatalogEntry,
  proxy: ProviderProxyOptions,
  objects: ManifestObject[],
  container: ContainerSettings,
  patches: Patch[],
): void {
  const { settings } = proxy;
  container.env.push(
    { name: 'HTTPS_PROXY', value: settings.httpsProxy },
    { name: 'HTTP_PROXY', value: settings.httpProxy ?? settings.httpsProxy },
    { name: 'NO_PROXY', value: effectiveNoProxy(settings.noProxy, proxy.apiServerIp) },
  );
  if (settings.caCert?.trim()) {
    objects.push(caSecret(PROXY_CA_SECRET, objects[0]!.metadata.name, settings.caCert));
    container.env.push({ name: 'SSL_CERT_DIR', value: PROXY_CA_MOUNT });
    patches.push(
      volumePatch(
        { kind: 'Deployment' },
        entry.tls?.containerIndex ?? 0,
        'capi-navigator-proxy-ca',
        PROXY_CA_SECRET,
        PROXY_CA_MOUNT,
      ),
    );
  }
  container.env.push({ name: 'CAPI_NAVIGATOR_OUTBOUND_PROXY', value: outboundProxyHash(settings) });
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
