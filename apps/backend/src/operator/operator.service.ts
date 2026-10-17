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
  PROVIDER_KINDS,
  PROVIDER_PLURALS,
  renderManifests,
  type ManifestObject,
  type ManifestPreview,
  type OperatorState,
  type ProviderCatalogEntry,
  type ProviderInstallSpec,
  type ProviderKind,
  type ProviderUsage,
  type ReleaseList,
} from '@capi-navigator/shared';
import { stringify } from 'yaml';
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import { serverSideApply } from '../kube/apply.js';
import { isNotFound, toHttpException } from '../kube/errors.js';
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

  constructor(private readonly clients: ManagementClusterClients) {}

  async state(connection: string): Promise<OperatorState> {
    const kc = await this.clients.forConnection(connection);
    return this.kube('Read the CAPI Operator state', async () => {
      const [prerequisites, providers] = await Promise.all([
        detectPrerequisites(kc),
        listProviders(kc),
      ]);
      return { prerequisites, providers: providers.map(toInstalledProvider) };
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
    const objects = buildProviderManifests(entry, spec);
    await this.dryRun(kc, objects, warnings);
    return preview(objects, warnings);
  }

  async install(connection: string, input: ProviderInstallSpec): Promise<ManifestPreview> {
    const spec = withDefaultVariables(input);
    const { kc, entry, warnings } = await this.checkInstall(connection, spec);
    const objects = buildProviderManifests(entry, spec);
    await this.kube(`Install ${entry.displayName}`, () =>
      serverSideApply(kc, objects as KubernetesObject[]),
    );
    return preview(objects, warnings);
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
    // Remove the configuration Secret only if the app created it.
    const ref = provider.spec?.configSecret;
    if (ref) {
      const core = kc.makeApiClient(CoreV1Api);
      const ns = ref.namespace ?? target.namespace;
      const secret = await core
        .readNamespacedSecret({ name: ref.name, namespace: ns })
        .catch(() => undefined);
      if (secret?.metadata?.labels?.[MANAGED_BY_LABEL] === MANAGED_BY_VALUE) {
        await core.deleteNamespacedSecret({ name: ref.name, namespace: ns }).catch(() => undefined);
      }
    }
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
    let objects: ManifestObject[] = buildProviderManifests(entry, spec);
    if (update.variables === undefined && current.spec?.configSecret) {
      // Keep the stored variables: reference the existing Secret, do not touch it.
      const ref = current.spec.configSecret;
      objects = objects.map((o) =>
        o.kind === entry.kind ? { ...o, spec: { ...(o.spec as object), configSecret: ref } } : o,
      );
    }
    const warnings: string[] = [];
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
