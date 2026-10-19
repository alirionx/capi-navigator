import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { CoreV1Api } from '@kubernetes/client-node';
import {
  ADDON_PRESETS_CONFIGMAP,
  ADDON_PRESETS_CONFIGMAP_KEY,
  AddonPresetOverridesSchema,
  AuditEventCrd,
  HelmRepositoryCrd,
  ManagementClusterCrd,
  NavigatorRoleCrd,
  NavigatorTokenCrd,
  NavigatorUserCrd,
  BUILTIN_ROLES,
  isBuiltinRole,
  type Permission,
  type NavigatorRoleSpecSchema,
  type NavigatorTokenSpecSchema,
  type AddonPresetOverrides,
  type AuditEventSpecSchema,
  type HelmRepositorySpecSchema,
  type ManagementClusterSpecSchema,
  type NavigatorUserSpecSchema,
} from '@capi-navigator/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { isNotFound } from '../kube/errors.js';
import { KubeClientFactory } from '../kube/kube-client.factory.js';
import { FIELD_MANAGER } from './custom-resource.client.js';
import { CustomResourceClient } from './custom-resource.client.js';
import { ResourceCache } from './resource-cache.js';
import { SecretStore } from './secret.store.js';

/**
 * Typed access to the app's own state in the home cluster (section 4, State storage).
 * No database, no local files (STATE-01); reads go through informer caches (STATE-03).
 */
@Injectable()
export class StoreService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(StoreService.name);

  readonly users: CustomResourceClient<typeof NavigatorUserSpecSchema>;
  readonly userCache: ResourceCache<typeof NavigatorUserSpecSchema>;
  readonly auditEvents: CustomResourceClient<typeof AuditEventSpecSchema>;
  readonly connections: CustomResourceClient<typeof ManagementClusterSpecSchema>;
  readonly connectionCache: ResourceCache<typeof ManagementClusterSpecSchema>;
  readonly helmRepositories: CustomResourceClient<typeof HelmRepositorySpecSchema>;
  readonly helmRepositoryCache: ResourceCache<typeof HelmRepositorySpecSchema>;
  readonly roles: CustomResourceClient<typeof NavigatorRoleSpecSchema>;
  readonly roleCache: ResourceCache<typeof NavigatorRoleSpecSchema>;
  readonly tokens: CustomResourceClient<typeof NavigatorTokenSpecSchema>;
  readonly tokenCache: ResourceCache<typeof NavigatorTokenSpecSchema>;
  readonly secrets: SecretStore;
  private readonly core: CoreV1Api;

  constructor(kube: KubeClientFactory, @Inject(APP_CONFIG) config: AppConfig) {
    const kc = kube.homeCluster();
    const ns = config.NAVIGATOR_NAMESPACE;
    this.users = new CustomResourceClient(kc, ns, NavigatorUserCrd);
    this.userCache = new ResourceCache(kc, this.users);
    this.auditEvents = new CustomResourceClient(kc, ns, AuditEventCrd);
    this.connections = new CustomResourceClient(kc, ns, ManagementClusterCrd);
    this.connectionCache = new ResourceCache(kc, this.connections);
    this.helmRepositories = new CustomResourceClient(kc, ns, HelmRepositoryCrd);
    this.helmRepositoryCache = new ResourceCache(kc, this.helmRepositories);
    this.roles = new CustomResourceClient(kc, ns, NavigatorRoleCrd);
    this.roleCache = new ResourceCache(kc, this.roles);
    this.tokens = new CustomResourceClient(kc, ns, NavigatorTokenCrd);
    this.tokenCache = new ResourceCache(kc, this.tokens);
    this.secrets = new SecretStore(kc, ns);
    this.core = kc.makeApiClient(CoreV1Api);
  }

  get namespace(): string {
    return this.users.namespace;
  }

  /**
   * Permissions of a role (FP19-F-01, FP19-F-02): built-in roles from code, custom roles from the
   * cache; `undefined` for an unknown role. Custom roles always grant `view`.
   */
  readonly rolePermissions = (role: string): readonly Permission[] | undefined => {
    if (isBuiltinRole(role)) return BUILTIN_ROLES[role].permissions;
    const custom = this.roleCache.get(role);
    if (!custom) return undefined;
    return ['view', ...custom.spec.permissions.filter((p) => p !== 'view')];
  };

  /** Admin overrides of the CCM/CSI presets (FP8-F-14); empty when none are stored. */
  async addonPresetOverrides(): Promise<AddonPresetOverrides> {
    try {
      const cm = await this.core.readNamespacedConfigMap({
        name: ADDON_PRESETS_CONFIGMAP,
        namespace: this.namespace,
      });
      const parsed = AddonPresetOverridesSchema.safeParse(
        JSON.parse(cm.data?.[ADDON_PRESETS_CONFIGMAP_KEY] ?? '{}'),
      );
      if (!parsed.success) {
        this.logger.warn(`Ignoring ${ADDON_PRESETS_CONFIGMAP}: content does not match the schema`);
        return {};
      }
      return parsed.data;
    } catch (err) {
      if (isNotFound(err)) return {};
      throw err;
    }
  }

  async putAddonPresetOverrides(overrides: AddonPresetOverrides): Promise<void> {
    const body = {
      metadata: {
        name: ADDON_PRESETS_CONFIGMAP,
        namespace: this.namespace,
        labels: { 'app.kubernetes.io/part-of': 'capi-navigator' },
      },
      data: { [ADDON_PRESETS_CONFIGMAP_KEY]: JSON.stringify(overrides, null, 2) },
    };
    try {
      await this.core.replaceNamespacedConfigMap({
        name: ADDON_PRESETS_CONFIGMAP,
        namespace: this.namespace,
        fieldManager: FIELD_MANAGER,
        body,
      });
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.core.createNamespacedConfigMap({
        namespace: this.namespace,
        fieldManager: FIELD_MANAGER,
        body,
      });
    }
  }

  /** True once all informer caches are synced; used by the readiness probe (NF-20). */
  get ready(): boolean {
    return (
      this.userCache.isSynced &&
      this.connectionCache.isSynced &&
      this.helmRepositoryCache.isSynced &&
      this.roleCache.isSynced &&
      this.tokenCache.isSynced
    );
  }

  async onModuleInit(): Promise<void> {
    try {
      await Promise.all([
        this.userCache.start(),
        this.connectionCache.start(),
        this.helmRepositoryCache.start(),
        this.roleCache.start(),
        this.tokenCache.start(),
      ]);
      this.logger.log(`Caches synced (namespace ${this.namespace})`);
    } catch (err) {
      this.logger.error(
        `Cannot read the app's resources in namespace ${this.namespace}. Are the CRDs installed (pnpm crds:install) and does the namespace exist? ${err instanceof Error ? err.message : ''}`,
      );
      throw err;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([
      this.userCache.stop(),
      this.connectionCache.stop(),
      this.helmRepositoryCache.stop(),
      this.roleCache.stop(),
      this.tokenCache.stop(),
    ]);
  }
}
