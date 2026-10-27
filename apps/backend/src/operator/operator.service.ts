import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CoreV1Api,
  CustomObjectsApi,
  type KubeConfig,
  type KubernetesObject,
} from '@kubernetes/client-node';
import {
  buildProviderManifests,
  catalogEntry,
  catalogEntryFor,
  compareVersions,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  OPERATOR_GROUP,
  OPERATOR_VERSION,
  ORC,
  orcVersionForCapo,
  OUTBOUND_PROXY_ANNOTATION,
  outboundProxyHash,
  PROXY_CA_SECRET,
  PROVIDER_KINDS,
  PROVIDER_PLURALS,
  renderManifests,
  type ManifestObject,
  type ManifestPreview,
  type OperatorState,
  type ProviderCatalogEntry,
  type ProviderInstallSpec,
  type ProviderKind,
  type ProviderProxyOptions,
  type ProviderUsage,
  type ReleaseList,
} from '@capi-navigator/shared';
import { stringify } from 'yaml';
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import { CredentialsService } from '../credentials/credentials.service.js';
import { serverSideApply } from '../kube/apply.js';
import { isNotFound, toHttpException } from '../kube/errors.js';
import { StoreService } from '../store/store.service.js';
import { fetchOrcManifest, OrcManifestError } from './orc-manifest.js';
import { detectPrerequisites } from './prerequisites.js';
import {
  clustersUsing,
  listProviders,
  toInstalledProvider,
  type ProviderObject,
} from './providers.js';
import { ReleaseFetcher } from './releases.js';

const conflict = (message: string, hint: string) =>
  new ConflictException({ statusCode: 409, message, hint });

/**
 * CAPI Operator, ORC and provider management on a management cluster (FP-3). Every call runs
 * with the credentials of the selected connection (NF-02).
 */
@Injectable()
export class OperatorService {
  readonly releases = new ReleaseFetcher();

  constructor(
    private readonly clients: ManagementClusterClients,
    private readonly credentials: CredentialsService,
    private readonly store: StoreService,
  ) {}

  /** CA bundle from the stored credentials for providers that verify TLS (FP31-F-01). */
  private async tlsOptions(connection: string, entry: ProviderCatalogEntry) {
    if (!entry.tls) return {};
    const caBundle = await this.credentials.caBundle(connection, entry.id);
    return caBundle ? { caBundle } : {};
  }

  /** Outbound proxy settings of the connection (FP-29). */
  private proxySettings(connection: string) {
    return this.store.connectionCache.get(connection)?.spec.outboundProxy;
  }

  /**
   * Outbound proxy for a provider (FP-29). The API server's ClusterIP goes into NO_PROXY: client-go
   * honours the proxy variables for its own API calls too.
   */
  private async proxyOptions(
    kc: KubeConfig,
    connection: string,
    use: boolean,
    warnings: string[],
  ): Promise<{ outboundProxy?: ProviderProxyOptions }> {
    const settings = this.proxySettings(connection);
    if (use && !settings) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'No outbound proxy is set for this management cluster',
        hint: 'Set it on the Providers page (Outbound proxy) first, or switch the proxy off.',
        fieldErrors: { outboundProxy: ['No outbound proxy is set'] },
      });
    }
    if (!use || !settings) return {};
    const apiServerIp = await kc
      .makeApiClient(CoreV1Api)
      .readNamespacedService({ name: 'kubernetes', namespace: 'default' })
      .then((svc) => svc.spec?.clusterIP)
      .catch(() => undefined);
    if (!apiServerIp) {
      warnings.push(
        'The ClusterIP of the Service default/kubernetes could not be read: add it to "No proxy", otherwise the controller sends its own API calls to the proxy.',
      );
    }
    return { outboundProxy: { settings, ...(apiServerIp ? { apiServerIp } : {}) } };
  }

  async state(connection: string): Promise<OperatorState> {
    const kc = await this.clients.forConnection(connection);
    const settings = this.proxySettings(connection);
    const proxyHash = settings ? outboundProxyHash(settings) : undefined;
    return this.kube('Read the CAPI Operator state', async () => {
      const [prerequisites, providers] = await Promise.all([
        detectPrerequisites(kc),
        listProviders(kc),
      ]);
      return {
        prerequisites,
        providers: providers.map((p) => toInstalledProvider(p, proxyHash)),
      };
    });
  }

  async providerReleases(catalogId: string): Promise<ReleaseList> {
    const entry = this.entry(catalogId);
    return this.releases.versions(entry.repository, entry.recommendedVersion);
  }

  async orcReleases(): Promise<ReleaseList> {
    return this.releases.versions(ORC.repository, orcVersionForCapo('v0.15')!);
  }

  // ---- Providers (FP3-F-08..13) ----

  async previewInstall(connection: string, input: ProviderInstallSpec): Promise<ManifestPreview> {
    const spec = withDefaultVariables(input);
    const { kc, entry, warnings } = await this.checkInstall(connection, spec);
    const objects = await this.installObjects(kc, connection, entry, spec, warnings);
    await this.dryRun(kc, objects, warnings);
    return preview(objects, warnings);
  }

  async install(connection: string, input: ProviderInstallSpec): Promise<ManifestPreview> {
    const spec = withDefaultVariables(input);
    const { kc, entry, warnings } = await this.checkInstall(connection, spec);
    const objects = await this.installObjects(kc, connection, entry, spec, warnings);
    await this.kube(`Install ${entry.displayName}`, () =>
      serverSideApply(kc, objects as KubernetesObject[]),
    );
    return preview(objects, warnings);
  }

  private async installObjects(
    kc: KubeConfig,
    connection: string,
    entry: ProviderCatalogEntry,
    spec: ProviderInstallSpec,
    warnings: string[],
  ): Promise<ManifestObject[]> {
    const use =
      spec.outboundProxy ?? (!!entry.outboundProxyDefault && !!this.proxySettings(connection));
    return buildProviderManifests(entry, spec, {
      ...(await this.tlsOptions(connection, entry)),
      ...(await this.proxyOptions(kc, connection, use, warnings)),
    });
  }

  async previewUpdate(
    connection: string,
    target: ProviderRef,
    update: ProviderUpdate,
  ): Promise<ManifestPreview> {
    const { kc, objects, warnings } = await this.prepareUpdate(connection, target, update);
    await this.dryRun(kc, objects, warnings);
    return preview(objects, warnings);
  }

  async update(
    connection: string,
    target: ProviderRef,
    update: ProviderUpdate,
  ): Promise<ManifestPreview> {
    const { kc, objects, warnings, entry } = await this.prepareUpdate(connection, target, update);
    await this.kube(`Update ${entry.displayName}`, () =>
      serverSideApply(kc, objects as KubernetesObject[]),
    );
    // Server-side apply leaves objects alone that are no longer generated (FP-29).
    if (!objects.some((o) => o.kind === 'Secret' && o.metadata.name === PROXY_CA_SECRET)) {
      await deleteOwnSecret(kc, target.namespace, PROXY_CA_SECRET);
    }
    return preview(objects, warnings);
  }

  async usage(connection: string, target: ProviderRef): Promise<ProviderUsage> {
    const kc = await this.clients.forConnection(connection);
    const entry = catalogEntryFor(target.kind, target.name);
    if (!entry) return { clusters: [] };
    return { clusters: await this.kube('List workload clusters', () => clustersUsing(kc, entry)) };
  }

  async variableNames(connection: string, target: ProviderRef): Promise<string[]> {
    const kc = await this.clients.forConnection(connection);
    const provider = await this.readProvider(kc, target);
    const ref = provider.spec?.configSecret;
    if (!ref) return [];
    try {
      const secret = await kc
        .makeApiClient(CoreV1Api)
        .readNamespacedSecret({ name: ref.name, namespace: ref.namespace ?? target.namespace });
      return Object.keys({ ...secret.data, ...secret.stringData }).sort();
    } catch (err) {
      if (isNotFound(err)) return [];
      throw toHttpException(err, 'Read the provider configuration');
    }
  }

  /** FP3-F-12: removal; refused while clusters use the provider unless `force` is set. */
  async remove(connection: string, target: ProviderRef, force: boolean): Promise<void> {
    const kc = await this.clients.forConnection(connection);
    const provider = await this.readProvider(kc, target);
    const entry = catalogEntryFor(target.kind, target.name);
    if (entry && !force) {
      const users = await this.kube('List workload clusters', () => clustersUsing(kc, entry));
      if (users.length > 0) {
        throw conflict(
          `${users.length} workload cluster(s) still use ${entry.displayName}`,
          `Delete or move these clusters first: ${users.map((c) => `${c.namespace}/${c.name}`).join(', ')}`,
        );
      }
    }
    if (entry?.id === 'core') {
      const others = (await listProviders(kc)).filter((p) => p.kind !== 'CoreProvider');
      if (others.length > 0) {
        throw conflict(
          'Other providers depend on the core provider',
          'Remove the other providers first.',
        );
      }
    }
    const api = kc.makeApiClient(CustomObjectsApi);
    await this.kube(`Remove provider ${target.name}`, () =>
      api.deleteNamespacedCustomObject({
        group: OPERATOR_GROUP,
        version: OPERATOR_VERSION,
        namespace: target.namespace,
        plural: PROVIDER_PLURALS[target.kind],
        name: target.name,
      }),
    );
    // Remove the configuration Secret and the proxy CA only if the app created them.
    const ref = provider.spec?.configSecret;
    if (ref) await deleteOwnSecret(kc, ref.namespace ?? target.namespace, ref.name);
    await deleteOwnSecret(kc, target.namespace, PROXY_CA_SECRET);
  }

  // ---- ORC (FP3-F-04a) ----

  async previewOrc(connection: string, version: string): Promise<ManifestPreview> {
    const kc = await this.clients.forConnection(connection);
    const objects = await this.orcObjects(version);
    return {
      yaml: objects.map((o) => stringify(o, { lineWidth: 0 })).join('---\n'),
      objects: objects.map(summary),
      warnings: await this.orcWarnings(kc, version),
    };
  }

  async installOrc(connection: string, version: string): Promise<ManifestPreview> {
    const kc = await this.clients.forConnection(connection);
    const objects = await this.orcObjects(version);
    // Explicit install/upgrade action: take over fields from an earlier kubectl install.
    await this.kube(`Install ORC ${version}`, () => serverSideApply(kc, objects, { force: true }));
    return { yaml: '', objects: objects.map(summary), warnings: [] };
  }

  // ---- helpers ----

  private async orcObjects(version: string): Promise<KubernetesObject[]> {
    try {
      return await fetchOrcManifest(version);
    } catch (err) {
      if (err instanceof OrcManifestError) {
        throw new HttpException(
          {
            statusCode: HttpStatus.BAD_GATEWAY,
            message: `Cannot load the ORC manifest: ${err.message}`,
            hint: `Install ORC manually instead: kubectl apply --server-side -f ${ORC.manifestUrl(version)}`,
          },
          HttpStatus.BAD_GATEWAY,
        );
      }
      throw err;
    }
  }

  private async orcWarnings(kc: KubeConfig, version: string): Promise<string[]> {
    const providers = await listProviders(kc).catch(() => []);
    const capo = providers.find(
      (p) => p.kind === 'InfrastructureProvider' && p.metadata.name === 'openstack',
    );
    const capoVersion = capo?.status?.installedVersion ?? capo?.spec?.version;
    const wanted = capoVersion ? orcVersionForCapo(capoVersion) : undefined;
    if (wanted && compareVersions(version, wanted) < 0) {
      return [`CAPO ${capoVersion} is built against ORC ${wanted}; ${version} is older.`];
    }
    return [];
  }

  private entry(catalogId: string): ProviderCatalogEntry {
    const entry = catalogEntry(catalogId);
    if (!entry) throw new NotFoundException(`Unknown provider "${catalogId}"`);
    return entry;
  }

  /** FP3-F-11 and acceptance: dependencies, ORC before CAPO, no duplicates. */
  private async checkInstall(connection: string, spec: ProviderInstallSpec) {
    const entry = this.entry(spec.catalogId);
    if (entry.availableFrom) {
      throw new BadRequestException({
        statusCode: 400,
        message: `${entry.displayName} is not available yet`,
        hint: `It is enabled in ${entry.availableFrom}.`,
      });
    }
    const kc = await this.clients.forConnection(connection);
    const state = await this.state(connection);
    const pre = state.prerequisites;
    if (!pre.certManager.ready || !pre.operator.ready) {
      throw conflict(
        'cert-manager and the CAPI Operator must be installed and ready first',
        'Follow the installation instructions on the Providers page.',
      );
    }
    const existing = state.providers.find((p) => p.kind === entry.kind && p.name === entry.name);
    if (existing) {
      throw conflict(
        `${entry.displayName} is already installed in namespace ${existing.namespace}`,
        'Use "Upgrade / configure" to change its version or configuration.',
      );
    }
    for (const dep of entry.dependsOn) {
      const depEntry = this.entry(dep);
      const installed = state.providers.find((p) => p.catalogId === dep);
      if (!installed || installed.phase !== 'Ready') {
        throw conflict(
          `${depEntry.displayName} must be installed and ready first`,
          `Install ${depEntry.displayName} before ${entry.displayName}.`,
        );
      }
    }
    const warnings: string[] = [];
    if (entry.requiresOrc) {
      if (!pre.orc.ready) {
        throw conflict(
          `${entry.displayName} requires the OpenStack Resource Controller (ORC)`,
          'Install ORC first (Providers page → ORC → Install).',
        );
      }
      const wanted = orcVersionForCapo(spec.version);
      if (wanted && pre.orc.version && compareVersions(pre.orc.version, wanted) < 0) {
        warnings.push(
          `CAPO ${spec.version} is built against ORC ${wanted}, but ORC ${pre.orc.version} is installed. Upgrade ORC first.`,
        );
      }
    }
    return { kc, entry, warnings };
  }

  private async prepareUpdate(connection: string, target: ProviderRef, update: ProviderUpdate) {
    const entry = catalogEntryFor(target.kind, target.name);
    if (!entry) throw new BadRequestException('Only providers from the catalog can be updated');
    const kc = await this.clients.forConnection(connection);
    const current = await this.readProvider(kc, target);
    const installed = current.status?.installedVersion ?? current.spec?.version;
    if (installed && compareVersions(update.version, installed) < 0) {
      throw new BadRequestException({
        statusCode: 400,
        message: `Downgrades are not supported (installed: ${installed})`,
        hint: 'The CAPI Operator only upgrades providers. Choose the same or a newer version.',
        fieldErrors: { version: ['Downgrades are not supported'] },
      });
    }
    const spec: ProviderInstallSpec = {
      catalogId: entry.id,
      version: update.version,
      namespace: target.namespace,
      variables: update.variables ?? {},
      featureGates: update.featureGates,
      ...(current.spec?.fetchConfig?.url ? { fetchConfigUrl: current.spec.fetchConfig.url } : {}),
    };
    const warnings: string[] = [];
    const useProxy =
      update.outboundProxy ?? !!current.metadata.annotations?.[OUTBOUND_PROXY_ANNOTATION];
    let objects: ManifestObject[] = buildProviderManifests(entry, spec, {
      ...(await this.tlsOptions(connection, entry)),
      ...(await this.proxyOptions(kc, connection, useProxy, warnings)),
    });
    if (update.variables === undefined && current.spec?.configSecret) {
      // Keep the stored variables: reference the existing Secret, do not touch it.
      const ref = current.spec.configSecret;
      objects = objects.map((o) =>
        o.kind === entry.kind ? { ...o, spec: { ...(o.spec as object), configSecret: ref } } : o,
      );
    }
    if (entry.requiresOrc) {
      const pre = (await this.state(connection)).prerequisites;
      const wanted = orcVersionForCapo(update.version);
      if (wanted && pre.orc.version && compareVersions(pre.orc.version, wanted) < 0) {
        warnings.push(`CAPO ${update.version} is built against ORC ${wanted}; upgrade ORC first.`);
      }
    }
    return { kc, objects, warnings, entry };
  }

  private async readProvider(kc: KubeConfig, target: ProviderRef): Promise<ProviderObject> {
    try {
      const obj = (await kc.makeApiClient(CustomObjectsApi).getNamespacedCustomObject({
        group: OPERATOR_GROUP,
        version: OPERATOR_VERSION,
        namespace: target.namespace,
        plural: PROVIDER_PLURALS[target.kind],
        name: target.name,
      })) as Omit<ProviderObject, 'kind'>;
      return { ...obj, kind: target.kind };
    } catch (err) {
      if (isNotFound(err)) {
        throw new NotFoundException(`${target.kind} ${target.namespace}/${target.name} not found`);
      }
      throw toHttpException(err, 'Read the provider');
    }
  }

  /**
   * Validates with dryRun=All (FP5-F-08 pattern). Objects in a namespace that does not exist yet
   * cannot be dry-run; they are validated when applied.
   */
  private async dryRun(kc: KubeConfig, objects: ManifestObject[], warnings: string[]) {
    const core = kc.makeApiClient(CoreV1Api);
    const ns = objects.find((o) => o.kind === 'Namespace')?.metadata.name;
    const nsExists = ns
      ? await core.readNamespace({ name: ns }).then(
          () => true,
          (err: unknown) => {
            if (isNotFound(err)) return false;
            throw toHttpException(err, 'Read namespace');
          },
        )
      : true;
    const checkable = nsExists ? objects : objects.filter((o) => !o.metadata.namespace);
    if (!nsExists) {
      warnings.push(`Namespace ${ns} will be created; its objects are validated when applied.`);
    }
    await this.kube('Validate the manifests (dry run)', () =>
      serverSideApply(kc, checkable as KubernetesObject[], { dryRun: true }),
    );
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

export interface ProviderRef {
  kind: ProviderKind;
  namespace: string;
  name: string;
}

export interface ProviderUpdate {
  version: string;
  variables?: Record<string, string>;
  featureGates: Record<string, boolean>;
  /** FP-29; omitted: keep the current choice. */
  outboundProxy?: boolean;
}

/** Deletes a Secret only if the app created it (label); missing Secrets are fine. */
async function deleteOwnSecret(kc: KubeConfig, namespace: string, name: string): Promise<void> {
  const core = kc.makeApiClient(CoreV1Api);
  const secret = await core.readNamespacedSecret({ name, namespace }).catch(() => undefined);
  if (secret?.metadata?.labels?.[MANAGED_BY_LABEL] === MANAGED_BY_VALUE) {
    await core.deleteNamespacedSecret({ name, namespace }).catch(() => undefined);
  }
}

export function isProviderKind(kind: string): kind is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(kind);
}

/** Adds the catalog's required variables (e.g. AWS_B64ENCODED_CREDENTIALS) when missing. */
function withDefaultVariables(spec: ProviderInstallSpec): ProviderInstallSpec {
  const defaults = catalogEntry(spec.catalogId)?.defaultVariables ?? {};
  return { ...spec, variables: { ...defaults, ...spec.variables } };
}

function summary(o: { kind?: string; metadata?: { name?: string; namespace?: string } }) {
  return {
    kind: o.kind ?? '',
    name: o.metadata?.name ?? '',
    ...(o.metadata?.namespace ? { namespace: o.metadata.namespace } : {}),
  };
}

function preview(objects: ManifestObject[], warnings: string[]): ManifestPreview {
  return {
    yaml: renderManifests(objects, { maskSecrets: true }),
    objects: objects.map(summary),
    warnings,
  };
}
