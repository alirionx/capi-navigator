import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CoreV1Api, CustomObjectsApi } from '@kubernetes/client-node';
import {
  HELM_REPOSITORY_ANNOTATION,
  helmRepositoryCopyName,
  helmRepositorySecretName,
  HelmRepositorySpecSchema,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  registryConfigJson,
  type AddonRepositoryRef,
  type ChartSummary,
  type ChartValues,
  type ChartVersion,
  type CreateHelmRepositoryRequest,
  type HelmRepository,
  type HelmRepositorySpec,
  type HelmRepositoryTestResult,
  type NavigatorResource,
  type UpdateHelmRepositoryRequest,
} from '@capi-navigator/shared';
import { ManagementClusterClients } from '../connections/management-cluster-clients.js';
import { isNotFound } from '../kube/errors.js';
import { StoreService } from '../store/store.service.js';
import { ChartSource, type RepoAccess } from './chart-source.js';
import { FetchError } from './fetch.js';

const LABEL_REPOSITORY = 'capi-navigator.io/helm-repository';

/**
 * Helm repositories (FP8-F-02 to F-04). The resource holds URL and type; username, password and
 * CA certificate live in a Secret of the home cluster and never leave the backend (hard rule 8).
 */
@Injectable()
export class HelmRepositoriesService {
  private readonly logger = new Logger(HelmRepositoriesService.name);
  private readonly source = new ChartSource();

  constructor(
    private readonly store: StoreService,
    private readonly clients: ManagementClusterClients,
  ) {}

  list(): HelmRepository[] {
    return this.store.helmRepositoryCache.list().map(toApi);
  }

  get(name: string): HelmRepository {
    return toApi(this.resource(name));
  }

  async create(req: CreateHelmRepositoryRequest & { url: string }): Promise<HelmRepository> {
    if (this.store.helmRepositoryCache.get(req.name)) {
      throw new ConflictException(`Helm repository ${req.name} already exists`);
    }
    const spec = HelmRepositorySpecSchema.parse({
      ...(req.displayName ? { displayName: req.displayName } : {}),
      type: req.type,
      url: req.url,
      insecureSkipTLSVerify: req.insecureSkipTLSVerify ?? false,
      hasCredentials: !!req.credentials,
      hasCaCertificate: !!req.caCertificate,
    });
    if (req.credentials || req.caCertificate) {
      await this.store.secrets.put(
        helmRepositorySecretName(req.name),
        secretData(req.credentials ?? undefined, req.caCertificate ?? undefined),
        { [LABEL_REPOSITORY]: req.name },
      );
    }
    const created = await this.store.helmRepositories.create(
      { name: req.name, labels: { [LABEL_REPOSITORY]: req.name } },
      spec,
    );
    this.store.helmRepositoryCache.upsert(created);
    return toApi(created);
  }

  async update(name: string, req: UpdateHelmRepositoryRequest): Promise<HelmRepository> {
    const current = this.resource(name);
    const secretChanged = req.credentials !== undefined || req.caCertificate !== undefined;
    let credentials: { username: string; password: string } | undefined;
    let ca: string | undefined;
    if (secretChanged) {
      const old = (await this.store.secrets.get(helmRepositorySecretName(name))) ?? {};
      credentials =
        req.credentials === null
          ? undefined
          : (req.credentials ??
            (old.username !== undefined
              ? { username: old.username, password: old.password ?? '' }
              : undefined));
      ca = req.caCertificate === null ? undefined : (req.caCertificate ?? old['ca.crt']);
    }
    const spec = HelmRepositorySpecSchema.safeParse({
      ...current.spec,
      ...(req.displayName !== undefined ? { displayName: req.displayName } : {}),
      ...(req.url !== undefined ? { url: req.url } : {}),
      ...(req.insecureSkipTLSVerify !== undefined
        ? { insecureSkipTLSVerify: req.insecureSkipTLSVerify }
        : {}),
      ...(secretChanged
        ? {
            hasCredentials: !!credentials,
            hasCaCertificate: !!ca,
            credentialsRevision: current.spec.credentialsRevision + 1,
          }
        : {}),
    });
    if (!spec.success) {
      throw new BadRequestException({
        message: 'The repository is not valid',
        details: spec.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    if (spec.data.type === 'http' && (spec.data.hasCredentials || spec.data.hasCaCertificate)) {
      throw new BadRequestException('Credentials and CA certificates are supported for OCI only');
    }
    if (secretChanged) {
      if (credentials || ca) {
        await this.store.secrets.put(helmRepositorySecretName(name), secretData(credentials, ca), {
          [LABEL_REPOSITORY]: name,
        });
      } else {
        await this.store.secrets.delete(helmRepositorySecretName(name));
      }
    }
    const updated = await this.store.helmRepositories.patchSpec(
      name,
      spec.data,
      current.metadata.resourceVersion,
    );
    this.store.helmRepositoryCache.upsert(updated);
    if (secretChanged) await this.refreshCopies(name);
    return toApi(updated);
  }

  /** Refuses while add-ons of any connection still use the repository. */
  async delete(name: string): Promise<void> {
    this.resource(name);
    const sources = this.store.connectionCache
      .list()
      .filter((c) => c.spec.manifestChartRepository === name)
      .map((c) => c.metadata.name);
    if (sources.length) {
      throw new ConflictException({
        message: `Helm repository ${name} is the manifest chart source of ${sources.length} connection(s)`,
        hint: `Reset the chart source of these connections first: ${sources.join(', ')}`,
      });
    }
    const users = await this.usedBy(name);
    if (users.length) {
      throw new ConflictException({
        message: `Helm repository ${name} is used by ${users.length} add-on(s)`,
        hint: `Remove these add-ons first: ${users.join(', ')}`,
      });
    }
    await this.store.secrets.delete(helmRepositorySecretName(name));
    try {
      await this.store.helmRepositories.delete(name);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    this.store.helmRepositoryCache.remove(name);
  }

  async test(name: string): Promise<HelmRepositoryTestResult> {
    return this.source.test(await this.access(name));
  }

  /** Test from the form before saving; credentials only in memory. */
  testDraft(req: CreateHelmRepositoryRequest & { url: string }): Promise<HelmRepositoryTestResult> {
    return this.source.test({
      type: req.type,
      url: req.url,
      ...(req.credentials ? req.credentials : {}),
      ...(req.caCertificate ? { ca: req.caCertificate } : {}),
      ...(req.insecureSkipTLSVerify ? { insecureSkipTLSVerify: true } : {}),
    });
  }

  async charts(name: string): Promise<ChartSummary[]> {
    const access = await this.access(name);
    return this.browse(() => this.source.charts(access));
  }

  async versions(name: string, chart: string): Promise<ChartVersion[]> {
    const access = await this.access(name);
    return this.browse(() => this.source.versions(access, chart));
  }

  async values(name: string, chart: string, version: string): Promise<ChartValues> {
    const access = await this.access(name);
    const values = await this.browse(() => this.source.values(access, chart, version));
    return { chart, version, values };
  }

  /**
   * Versions of a chart in a repository of the app, or without one at an anonymous OCI URL
   * (FP30-F-03). Fetch errors are passed on unchanged.
   */
  async chartVersions(name: string | undefined, url: string, chart: string): Promise<string[]> {
    const access: RepoAccess = name ? await this.access(name) : { type: 'oci', url };
    return (await this.source.versions(access, chart)).map((v) => v.version);
  }

  /** Repository facts for the HelmChartProxy builder. */
  ref(name: string): AddonRepositoryRef {
    const r = this.resource(name);
    return {
      name,
      type: r.spec.type,
      url: r.spec.url,
      insecureSkipTLSVerify: r.spec.insecureSkipTLSVerify,
      hasCredentials: r.spec.hasCredentials,
      hasCaCertificate: r.spec.hasCaCertificate,
    };
  }

  /** Data of the Secret copy next to the HelmChartProxies (`config.json`, `ca.crt`). */
  async copyData(name: string): Promise<{ configJson?: string; caCrt?: string } | undefined> {
    const r = this.resource(name);
    if (!r.spec.hasCredentials && !r.spec.hasCaCertificate) return undefined;
    const secret = (await this.store.secrets.get(helmRepositorySecretName(name))) ?? {};
    return {
      ...(r.spec.hasCredentials && secret.username !== undefined
        ? { configJson: registryConfigJson(r.spec.url, secret.username, secret.password ?? '') }
        : {}),
      ...(r.spec.hasCaCertificate && secret['ca.crt'] ? { caCrt: secret['ca.crt'] } : {}),
    };
  }

  private resource(name: string): NavigatorResource<HelmRepositorySpec> {
    const r = this.store.helmRepositoryCache.get(name);
    if (!r) throw new NotFoundException(`Helm repository ${name} not found`);
    return r;
  }

  private async access(name: string): Promise<RepoAccess> {
    const r = this.resource(name);
    const secret =
      r.spec.hasCredentials || r.spec.hasCaCertificate
        ? ((await this.store.secrets.get(helmRepositorySecretName(name))) ?? {})
        : {};
    return {
      type: r.spec.type,
      url: r.spec.url,
      ...(r.spec.hasCredentials && secret.username !== undefined
        ? { username: secret.username, password: secret.password ?? '' }
        : {}),
      ...(secret['ca.crt'] ? { ca: secret['ca.crt'] } : {}),
      ...(r.spec.insecureSkipTLSVerify ? { insecureSkipTLSVerify: true } : {}),
    };
  }

  private async browse<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof FetchError) {
        if (err.status === 404) throw new NotFoundException(err.message);
        throw new BadGatewayException({
          message: err.message,
          hint:
            err.hint ??
            'The repository could not be read from the backend. Test it on the repositories page.',
        });
      }
      throw err;
    }
  }

  /** HelmChartProxies of all connections that use the repository. */
  private async usedBy(name: string): Promise<string[]> {
    const out: string[] = [];
    for (const conn of this.store.connectionCache.list()) {
      try {
        const kc = await this.clients.forConnection(conn.metadata.name);
        const list = (await kc.makeApiClient(CustomObjectsApi).listClusterCustomObject({
          group: 'addons.cluster.x-k8s.io',
          version: 'v1alpha1',
          plural: 'helmchartproxies',
        })) as {
          items: {
            metadata: { name: string; namespace: string; annotations?: Record<string, string> };
          }[];
        };
        for (const h of list.items) {
          if (h.metadata.annotations?.[HELM_REPOSITORY_ANNOTATION] === name) {
            out.push(`${conn.metadata.name}/${h.metadata.namespace}/${h.metadata.name}`);
          }
        }
      } catch (err) {
        this.logger.debug(`Connection ${conn.metadata.name} skipped: ${String(err)}`);
      }
    }
    return out;
  }

  /** Brings the Secret copies in all management clusters up to date after a change. */
  private async refreshCopies(name: string): Promise<void> {
    const data = (await this.copyData(name)) ?? {};
    for (const conn of this.store.connectionCache.list()) {
      try {
        const core = (await this.clients.forConnection(conn.metadata.name)).makeApiClient(
          CoreV1Api,
        );
        const secrets = await core.listSecretForAllNamespaces({
          labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
        });
        for (const s of secrets.items) {
          if (
            s.metadata?.name !== helmRepositoryCopyName(name) ||
            s.metadata.annotations?.[HELM_REPOSITORY_ANNOTATION] !== name
          ) {
            continue;
          }
          await core.replaceNamespacedSecret({
            name: s.metadata.name,
            namespace: s.metadata.namespace!,
            fieldManager: 'capi-navigator',
            body: {
              metadata: {
                name: s.metadata.name,
                namespace: s.metadata.namespace!,
                labels: s.metadata.labels ?? {},
                annotations: s.metadata.annotations ?? {},
                resourceVersion: s.metadata.resourceVersion!,
              },
              type: 'Opaque',
              stringData: {
                ...(data.configJson ? { 'config.json': data.configJson } : {}),
                ...(data.caCrt ? { 'ca.crt': data.caCrt } : {}),
              },
            },
          });
        }
      } catch (err) {
        this.logger.warn(
          `Could not refresh copies of Helm repository ${name} in ${conn.metadata.name}: ${String(err)}`,
        );
      }
    }
  }
}

function secretData(
  credentials: { username: string; password: string } | undefined,
  ca: string | undefined,
): Record<string, string> {
  return {
    ...(credentials ? { username: credentials.username, password: credentials.password } : {}),
    ...(ca ? { 'ca.crt': ca } : {}),
  };
}

function toApi(r: NavigatorResource<HelmRepositorySpec>): HelmRepository {
  return {
    name: r.metadata.name,
    ...(r.spec.displayName ? { displayName: r.spec.displayName } : {}),
    type: r.spec.type,
    url: r.spec.url,
    insecureSkipTLSVerify: r.spec.insecureSkipTLSVerify,
    hasCredentials: r.spec.hasCredentials,
    hasCaCertificate: r.spec.hasCaCertificate,
    ...(r.metadata.creationTimestamp ? { createdAt: r.metadata.creationTimestamp } : {}),
  };
}
