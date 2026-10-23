import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CoreV1Api,
  CustomObjectsApi,
  PatchStrategy,
  setHeaderOptions,
  type KubeConfig,
  type KubernetesObject,
  type V1Secret,
} from '@kubernetes/client-node';
import {
  catalogEntry,
  shortHash,
  CredentialSummarySchema,
  CredentialTestResultSchema,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  type CloudsYamlInfo,
  type CreateCredentialRequest,
  type Credential,
  type CredentialProvider,
  type CredentialSummary,
  type LookupKind,
  type LookupResponse,
  type ManifestPreview,
  type UpdateCredentialRequest,
} from '@capi-navigator/shared';
import { stringify } from 'yaml';
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import { deleteObjects, serverSideApply } from '../kube/apply.js';
import { isNotFound, toHttpException } from '../kube/errors.js';
import { listProviders } from '../operator/providers.js';
import {
  CredentialInputError,
  type CredentialPlugin,
} from '../infra-providers/credential-plugin.js';
import {
  cloudsYamlInfo,
  OpenStackCredentialError,
} from '../infra-providers/openstack/clouds-yaml.js';

export const CREDENTIAL_PLUGINS = Symbol('CREDENTIAL_PLUGINS');

const LABEL_CREDENTIAL = 'capi-navigator.io/credential';
const LABEL_PROVIDER = 'capi-navigator.io/credential-provider';
const ANN_DISPLAY = 'capi-navigator.io/display-name';
const ANN_SUMMARY = 'capi-navigator.io/summary';
const ANN_TEST = 'capi-navigator.io/last-test';
const MERGE_PATCH = setHeaderOptions('Content-Type', PatchStrategy.MergePatch);

/** Allowed namespaces of credentials without an identity resource (JSON array on the Secret). */
const ANN_ALLOWED = 'capi-navigator.io/allowed-namespaces';

export function credentialSecretName(name: string): string {
  return `capi-navigator-credential-${name}`;
}

interface Stored {
  secret: V1Secret;
  identity?: Record<string, unknown>;
}

/**
 * Infrastructure credentials on a management cluster (FP-4): one Secret in the provider namespace
 * plus a cluster-scoped identity (ADR-0002). Secret values never leave the backend (FP4-F-06).
 */
@Injectable()
export class CredentialsService {
  private readonly plugins: Map<CredentialProvider, CredentialPlugin>;

  constructor(
    private readonly clients: ManagementClusterClients,
    @Inject(CREDENTIAL_PLUGINS) plugins: CredentialPlugin[],
  ) {
    this.plugins = new Map(plugins.map((p) => [p.provider, p]));
  }

  cloudsYamlInfo(text: string): CloudsYamlInfo {
    try {
      return cloudsYamlInfo(text);
    } catch (err) {
      if (err instanceof OpenStackCredentialError)
        throw inputError(new CredentialInputError(err.message, err.hint, 'openstack.cloudsYaml'));
      throw err;
    }
  }

  async list(connection: string): Promise<Credential[]> {
    const kc = await this.clients.forConnection(connection);
    return this.kube('List credentials', async () => {
      const secrets = await kc
        .makeApiClient(CoreV1Api)
        .listSecretForAllNamespaces({ labelSelector: LABEL_PROVIDER });
      const identities = new Map<string, Record<string, unknown>>();
      for (const plugin of this.plugins.values()) {
        for (const id of await this.listIdentities(kc, plugin)) {
          identities.set(`${plugin.provider}/${(id.metadata as { name: string }).name}`, id);
        }
      }
      return secrets.items
        .map((secret) => {
          const provider = secret.metadata?.labels?.[LABEL_PROVIDER] as CredentialProvider;
          const name = secret.metadata?.labels?.[LABEL_CREDENTIAL] ?? '';
          if (!this.plugins.has(provider)) return undefined;
          return this.toCredential(provider, {
            secret,
            identity: identities.get(`${provider}/${name}`),
          });
        })
        .filter((c): c is Credential => !!c)
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
    });
  }

  async get(connection: string, provider: string, name: string): Promise<Credential> {
    const plugin = this.plugin(provider);
    const kc = await this.clients.forConnection(connection);
    return this.toCredential(plugin.provider, await this.read(kc, plugin, name));
  }

  /** FP-4, hard rule 6: what will be applied; Secret values are masked. */
  async preview(connection: string, req: CreateCredentialRequest): Promise<ManifestPreview> {
    const plugin = this.plugin(req.provider);
    const kc = await this.clients.forConnection(connection);
    const namespace = await this.providerNamespace(kc, plugin);
    const { objects } = this.build(plugin, req, namespace);
    return preview(objects);
  }

  async create(connection: string, req: CreateCredentialRequest): Promise<Credential> {
    const plugin = this.plugin(req.provider);
    const kc = await this.clients.forConnection(connection);
    const namespace = await this.providerNamespace(kc, plugin);
    const existing = await this.readSecret(kc, namespace, credentialSecretName(req.name));
    if (existing) {
      throw new ConflictException({
        statusCode: 409,
        message: `Credential "${req.name}" already exists`,
      });
    }
    const { objects, data, summary } = this.build(plugin, req, namespace);
    await this.kube(`Store credential ${req.name}`, async () => {
      try {
        await serverSideApply(kc, objects);
      } catch (err) {
        // Secret and identity belong together: if the identity is refused (e.g. the provider's
        // webhook is still starting), remove what was stored, so a retry does not fail with
        // "already exists" and no Secret without identity is left behind.
        await deleteObjects(kc, objects).catch(() => undefined);
        throw err;
      }
    });
    return this.runTest(kc, plugin, req.name, namespace, data, summary);
  }

  async update(
    connection: string,
    provider: string,
    name: string,
    req: UpdateCredentialRequest,
  ): Promise<Credential> {
    const plugin = this.plugin(provider);
    const inputs = req as Partial<Record<CredentialProvider, unknown>>;
    const other = [...this.plugins.keys()].find((p) => p !== plugin.provider && inputs[p]);
    if (other)
      throw new BadRequestException(`The credential "${name}" is a ${plugin.provider} credential`);
    const kc = await this.clients.forConnection(connection);
    const current = await this.read(kc, plugin, name);
    const namespace = current.secret.metadata!.namespace!;
    const input = inputs[plugin.provider];
    const currentSummary = parseSummary(current.secret);
    const allowed = req.allowedNamespaces ?? this.allowed(plugin, current);
    const displayName =
      req.displayName ?? current.secret.metadata?.annotations?.[ANN_DISPLAY] ?? '';

    let data = decode(current.secret);
    let summary = currentSummary;
    if (input) {
      const n = this.normalize(plugin, input);
      data = n.data;
      summary = n.summary;
      // New token without sizes: keep the sizes the admin set (FP31-F-04).
      if (!(input as { machineSizes?: unknown }).machineSizes && currentSummary.machineSizes) {
        summary = { ...summary, machineSizes: currentSummary.machineSizes };
      }
    }
    if (req.machineSizes) {
      if (!plugin.lookupKinds.includes('machineSizes')) {
        throw new BadRequestException(`${plugin.provider} credentials have no machine sizes`);
      }
      summary = { ...summary, machineSizes: req.machineSizes };
    }
    const objects = this.objects(plugin, name, namespace, displayName, allowed, data, summary);
    await this.kube(`Update credential ${name}`, () => serverSideApply(kc, objects));
    return input
      ? this.runTest(kc, plugin, name, namespace, data, summary)
      : this.get(connection, plugin.provider, name);
  }

  async remove(connection: string, provider: string, name: string): Promise<void> {
    const plugin = this.plugin(provider);
    const kc = await this.clients.forConnection(connection);
    const current = await this.read(kc, plugin, name);
    const users = await this.clustersUsing(kc, plugin, name, current.secret);
    if (users.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        message: `${users.length} workload cluster(s) still use credential "${name}"`,
        hint: `Delete these clusters first: ${users.join(', ')}`,
      });
    }
    const def = plugin.identity?.resource;
    await this.kube(`Delete credential ${name}`, async () => {
      if (def) {
        await kc
          .makeApiClient(CustomObjectsApi)
          .deleteClusterCustomObject({
            group: def.group,
            version: def.version,
            plural: def.plural,
            name,
          })
          .catch((err: unknown) => {
            if (!isNotFound(err)) throw err;
          });
      }
      await kc.makeApiClient(CoreV1Api).deleteNamespacedSecret({
        name: current.secret.metadata!.name!,
        namespace: current.secret.metadata!.namespace!,
      });
    });
  }

  /** FP4-F-04, FP4-F-09: test and store the result on the Secret. */
  async test(connection: string, provider: string, name: string): Promise<Credential> {
    const plugin = this.plugin(provider);
    const kc = await this.clients.forConnection(connection);
    const current = await this.read(kc, plugin, name);
    return this.runTest(
      kc,
      plugin,
      name,
      current.secret.metadata!.namespace!,
      decode(current.secret),
      parseSummary(current.secret),
    );
  }

  /** FP4-F-05, FP4-F-10: selection lists for the cluster wizard. */
  async lookup(
    connection: string,
    provider: string,
    name: string,
    kind: string,
    region?: string,
  ): Promise<LookupResponse> {
    const plugin = this.plugin(provider);
    if (!(plugin.lookupKinds as readonly string[]).includes(kind)) {
      throw new NotFoundException(`Unknown selection list "${kind}" for ${plugin.provider}`);
    }
    const kc = await this.clients.forConnection(connection);
    const current = await this.read(kc, plugin, name);
    try {
      const summary = parseSummary(current.secret);
      const options = await plugin.lookup(
        decode(current.secret),
        summary,
        kind as LookupKind,
        region ? { region } : {},
      );
      const r = region ?? summary.region;
      return { kind, ...(r ? { region: r } : {}), options };
    } catch (err) {
      if (err instanceof CredentialInputError) {
        throw new HttpException(
          { statusCode: 502, message: err.message, ...(err.hint ? { hint: err.hint } : {}) },
          502,
        );
      }
      throw err;
    }
  }

  /** Image names by ID for the cluster detail view (read-only); unknown IDs are left out. */
  async imageNames(
    connection: string,
    provider: string,
    name: string,
    ids: string[],
    region?: string,
  ): Promise<Record<string, string>> {
    const plugin = this.plugin(provider);
    const kc = await this.clients.forConnection(connection);
    const current = await this.read(kc, plugin, name);
    return plugin.imageNames(
      decode(current.secret),
      parseSummary(current.secret),
      ids,
      region ? { region } : {},
    );
  }

  /**
   * For the cluster wizard (FP-5): the stored credential with its decoded Secret data. Only for
   * use inside the backend (cloud config of the OpenStack CCM); never returned to clients.
   */
  async resolve(
    connection: string,
    provider: string,
    name: string,
  ): Promise<{ credential: Credential; data: Record<string, string> }> {
    const plugin = this.plugin(provider);
    const kc = await this.clients.forConnection(connection);
    const stored = await this.read(kc, plugin, name);
    return { credential: this.toCredential(plugin.provider, stored), data: decode(stored.secret) };
  }

  /** Adds a namespace to the credential's allowed namespaces (ADR-0002). */
  async allowNamespace(
    connection: string,
    provider: string,
    name: string,
    namespace: string,
  ): Promise<Credential> {
    const current = await this.get(connection, provider, name);
    if (current.allowedNamespaces.includes(namespace)) return current;
    return this.update(connection, provider, name, {
      allowedNamespaces: [...current.allowedNamespaces, namespace],
    });
  }

  // ---- helpers ----

  private plugin(provider: string): CredentialPlugin {
    const plugin = this.plugins.get(provider as CredentialProvider);
    if (!plugin) throw new NotFoundException(`Unknown provider "${provider}"`);
    return plugin;
  }

  private normalize(plugin: CredentialPlugin, input: unknown) {
    try {
      return plugin.normalize(input);
    } catch (err) {
      if (err instanceof CredentialInputError) throw inputError(err);
      throw err;
    }
  }

  private build(plugin: CredentialPlugin, req: CreateCredentialRequest, namespace: string) {
    const input = (req as Partial<Record<CredentialProvider, unknown>>)[plugin.provider];
    const { data, summary } = this.normalize(plugin, input);
    const objects = this.objects(
      plugin,
      req.name,
      namespace,
      req.displayName ?? '',
      req.allowedNamespaces ?? ['default'],
      data,
      summary,
    );
    return { objects, data, summary };
  }

  private objects(
    plugin: CredentialPlugin,
    name: string,
    namespace: string,
    displayName: string,
    allowedNamespaces: string[],
    data: Record<string, string>,
    summary: CredentialSummary,
  ): KubernetesObject[] {
    const labels = {
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [LABEL_CREDENTIAL]: name,
      [LABEL_PROVIDER]: plugin.provider,
    };
    const secretRef = { name: credentialSecretName(name), namespace };
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        ...secretRef,
        labels,
        annotations: {
          [ANN_DISPLAY]: displayName,
          [ANN_SUMMARY]: JSON.stringify(summary),
          // Without an identity resource the app keeps (and enforces) the allowed namespaces.
          ...(plugin.identity
            ? {}
            : { [ANN_ALLOWED]: JSON.stringify([...allowedNamespaces].sort()) }),
        },
      },
      type: 'Opaque',
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, Buffer.from(v, 'utf8').toString('base64')]),
      ),
    };
    if (!plugin.identity) return [secret];
    const identity = plugin.identity.build(name, secretRef, allowedNamespaces) as KubernetesObject;
    identity.metadata = { ...identity.metadata, labels };
    return [secret, identity];
  }

  /** CA certificates of all stored credentials of a provider, for its controller (FP31-F-01). */
  async caBundle(connection: string, catalogId: string): Promise<string | undefined> {
    const plugin = [...this.plugins.values()].find((p) => p.catalogId === catalogId);
    if (!plugin?.caDataKey) return undefined;
    const kc = await this.clients.forConnection(connection);
    return this.kube('Read the CA certificates of the credentials', () => this.bundle(kc, plugin));
  }

  private async bundle(kc: KubeConfig, plugin: CredentialPlugin): Promise<string | undefined> {
    const secrets = await kc
      .makeApiClient(CoreV1Api)
      .listSecretForAllNamespaces({ labelSelector: `${LABEL_PROVIDER}=${plugin.provider}` });
    const cas = secrets.items
      .sort((a, b) =>
        (a.metadata?.labels?.[LABEL_CREDENTIAL] ?? '').localeCompare(
          b.metadata?.labels?.[LABEL_CREDENTIAL] ?? '',
        ),
      )
      .map((s) => decode(s)[plugin.caDataKey!]?.trim())
      .filter((ca): ca is string => !!ca);
    const unique = [...new Set(cas)];
    return unique.length ? `${unique.join('\n')}\n` : undefined;
  }

  /** Whether the installed provider runs with the current CA bundle (FP31-F-01). */
  private async providerTrustsBundle(kc: KubeConfig, plugin: CredentialPlugin): Promise<boolean> {
    const entry = catalogEntry(plugin.catalogId)!;
    const installed = (await listProviders(kc)).find(
      (p) => p.kind === entry.kind && p.metadata.name === entry.name,
    );
    const env = installed?.spec?.deployment?.containers
      ?.find((c) => c.name === entry.tls?.container)
      ?.env?.find((e) => e.name === 'CAPI_NAVIGATOR_CA_BUNDLE')?.value;
    const bundle = await this.bundle(kc, plugin);
    return !!bundle && env === shortHash(bundle);
  }

  private async runTest(
    kc: KubeConfig,
    plugin: CredentialPlugin,
    name: string,
    namespace: string,
    data: Record<string, string>,
    summary: CredentialSummary,
  ): Promise<Credential> {
    const result = await plugin.test(data, summary);
    if (plugin.caDataKey && data[plugin.caDataKey]) {
      const trusted = await this.providerTrustsBundle(kc, plugin).catch(() => true);
      if (!trusted) {
        const entry = catalogEntry(plugin.catalogId)!;
        result.checks.push({
          id: 'provider-ca',
          name: `${entry.displayName} trusts this CA`,
          ok: false,
          warning: true,
          message:
            'The provider still runs with an older CA bundle: update it on the Providers page (same version) to apply the CA certificates of all credentials.',
        });
      }
    }
    await this.kube('Store the test result', () =>
      kc.makeApiClient(CoreV1Api).patchNamespacedSecret(
        {
          name: credentialSecretName(name),
          namespace,
          body: { metadata: { annotations: { [ANN_TEST]: JSON.stringify(result) } } },
        },
        MERGE_PATCH,
      ),
    );
    return this.toCredential(plugin.provider, await this.read(kc, plugin, name));
  }

  /** The namespace of the installed infrastructure provider (FP-3), where Secrets live. */
  private async providerNamespace(kc: KubeConfig, plugin: CredentialPlugin): Promise<string> {
    const entry = catalogEntry(plugin.catalogId)!;
    const providers = await this.kube('Read providers', () => listProviders(kc));
    const installed = providers.find(
      (p) => p.kind === entry.kind && p.metadata.name === entry.name,
    );
    if (!installed) {
      throw new ConflictException({
        statusCode: 409,
        message: `${entry.displayName} is not installed on this management cluster`,
        hint: 'Install it on the Providers page first.',
      });
    }
    return installed.metadata.namespace;
  }

  private async read(kc: KubeConfig, plugin: CredentialPlugin, name: string): Promise<Stored> {
    const secrets = await this.kube('Read credential', () =>
      kc.makeApiClient(CoreV1Api).listSecretForAllNamespaces({
        labelSelector: `${LABEL_PROVIDER}=${plugin.provider},${LABEL_CREDENTIAL}=${name}`,
      }),
    );
    const secret = secrets.items[0];
    if (!secret) throw new NotFoundException(`Credential "${name}" not found`);
    const def = plugin.identity?.resource;
    if (!def) return { secret };
    const identity = await kc
      .makeApiClient(CustomObjectsApi)
      .getClusterCustomObject({ group: def.group, version: def.version, plural: def.plural, name })
      .then(
        (o) => o as Record<string, unknown>,
        (err: unknown) => {
          if (isNotFound(err)) return undefined;
          throw toHttpException(err, 'Read identity');
        },
      );
    return { secret, ...(identity ? { identity } : {}) };
  }

  private async readSecret(
    kc: KubeConfig,
    namespace: string,
    name: string,
  ): Promise<V1Secret | undefined> {
    try {
      return await kc.makeApiClient(CoreV1Api).readNamespacedSecret({ name, namespace });
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw toHttpException(err, 'Read credential');
    }
  }

  private async listIdentities(
    kc: KubeConfig,
    plugin: CredentialPlugin,
  ): Promise<Record<string, unknown>[]> {
    const def = plugin.identity?.resource;
    if (!def) return [];
    try {
      const res = (await kc.makeApiClient(CustomObjectsApi).listClusterCustomObject({
        group: def.group,
        version: def.version,
        plural: def.plural,
        labelSelector: LABEL_CREDENTIAL,
      })) as { items: Record<string, unknown>[] };
      return res.items;
    } catch (err) {
      if (isNotFound(err)) return []; // provider (CRD) not installed
      throw err;
    }
  }

  private async clustersUsing(
    kc: KubeConfig,
    plugin: CredentialPlugin,
    name: string,
    secret: V1Secret,
  ): Promise<string[]> {
    const { version, plural, usesCredential } = plugin.clusterKind;
    const credential = {
      name,
      secret: { name: secret.metadata!.name!, namespace: secret.metadata!.namespace! },
    };
    try {
      const res = (await kc.makeApiClient(CustomObjectsApi).listClusterCustomObject({
        group: 'infrastructure.cluster.x-k8s.io',
        version,
        plural,
      })) as {
        items: (Record<string, unknown> & { metadata: { name: string; namespace: string } })[];
      };
      return res.items
        .filter((c) => usesCredential(c, credential))
        .map((c) => `${c.metadata.namespace}/${c.metadata.name}`);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw toHttpException(err, 'List workload clusters');
    }
  }

  /** Allowed namespaces from the identity resource, or from the Secret for providers without. */
  private allowed(plugin: CredentialPlugin, { secret, identity }: Stored): string[] {
    if (plugin.identity) return identity ? plugin.identity.allowedNamespaces(identity) : [];
    const stored = secret.metadata?.annotations?.[ANN_ALLOWED];
    try {
      const parsed: unknown = stored ? JSON.parse(stored) : [];
      return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : [];
    } catch {
      return [];
    }
  }

  private toCredential(provider: CredentialProvider, stored: Stored): Credential {
    const { secret } = stored;
    const plugin = this.plugin(provider);
    const def = plugin.identity?.resource;
    const ann = secret.metadata?.annotations ?? {};
    const name = secret.metadata?.labels?.[LABEL_CREDENTIAL] ?? '';
    const lastTest = parseJson(ann[ANN_TEST], CredentialTestResultSchema);
    return {
      name,
      provider,
      ...(ann[ANN_DISPLAY] ? { displayName: ann[ANN_DISPLAY] } : {}),
      allowedNamespaces: this.allowed(plugin, stored),
      summary: parseSummary(secret),
      // What clusters reference: the identity resource, or the Secret itself (e.g. CAPG).
      identity: def
        ? { apiVersion: def.apiVersion, kind: def.kind, name }
        : { apiVersion: 'v1', kind: 'Secret', name: secret.metadata!.name! },
      secret: { name: secret.metadata!.name!, namespace: secret.metadata!.namespace! },
      ...(secret.metadata?.creationTimestamp
        ? { createdAt: new Date(secret.metadata.creationTimestamp).toISOString() }
        : {}),
      ...(lastTest ? { lastTest } : {}),
    };
  }

  private async kube<T>(context: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw toHttpException(err, context);
    }
  }
}

function inputError(err: CredentialInputError): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    message: err.message,
    ...(err.hint ? { hint: err.hint } : {}),
    ...(err.field ? { fieldErrors: { [err.field]: [err.message] } } : {}),
  });
}

function decode(secret: V1Secret): Record<string, string> {
  return Object.fromEntries(
    Object.entries(secret.data ?? {}).map(([k, v]) => [
      k,
      Buffer.from(v, 'base64').toString('utf8'),
    ]),
  );
}

function parseJson<T>(
  text: string | undefined,
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
): T | undefined {
  if (!text) return undefined;
  try {
    const r = schema.safeParse(JSON.parse(text));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

function parseSummary(secret: V1Secret): CredentialSummary {
  return parseJson(secret.metadata?.annotations?.[ANN_SUMMARY], CredentialSummarySchema) ?? {};
}

function preview(objects: KubernetesObject[]): ManifestPreview {
  const masked = objects.map((o) =>
    o.kind === 'Secret'
      ? {
          ...o,
          data: Object.fromEntries(
            Object.keys((o as { data?: object }).data ?? {}).map((k) => [k, '********']),
          ),
        }
      : o,
  );
  return {
    yaml: masked.map((o) => stringify(o, { lineWidth: 0 })).join('---\n'),
    objects: objects.map((o) => ({
      kind: o.kind ?? '',
      name: o.metadata?.name ?? '',
      ...(o.metadata?.namespace ? { namespace: o.metadata.namespace } : {}),
    })),
    warnings: [],
  };
}
