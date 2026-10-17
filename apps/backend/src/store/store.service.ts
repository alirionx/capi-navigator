import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import {
  AuditEventCrd,
  NavigatorUserCrd,
  type AuditEventSpecSchema,
  type NavigatorUserSpecSchema,
} from '@capi-navigator/shared';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { KubeClientFactory } from '../kube/kube-client.factory.js';
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
  readonly secrets: SecretStore;

  constructor(kube: KubeClientFactory, @Inject(APP_CONFIG) config: AppConfig) {
    const kc = kube.homeCluster();
    const ns = config.NAVIGATOR_NAMESPACE;
    this.users = new CustomResourceClient(kc, ns, NavigatorUserCrd);
    this.userCache = new ResourceCache(kc, this.users);
    this.auditEvents = new CustomResourceClient(kc, ns, AuditEventCrd);
    this.secrets = new SecretStore(kc, ns);
  }

  get namespace(): string {
    return this.users.namespace;
  }

  /** True once all informer caches are synced; used by the readiness probe (NF-20). */
  get ready(): boolean {
    return this.userCache.isSynced;
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.userCache.start();
      this.logger.log(`User cache synced (namespace ${this.namespace})`);
    } catch (err) {
      this.logger.error(
        `Cannot read NavigatorUsers in namespace ${this.namespace}. Are the CRDs installed (pnpm crds:install) and does the namespace exist? ${err instanceof Error ? err.message : ''}`,
      );
      throw err;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.userCache.stop();
  }
}
