import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { CoordinationV1Api, V1MicroTime, type V1Lease } from '@kubernetes/client-node';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { isConflict, isNotFound } from '../kube/errors.js';
import { KubeClientFactory } from '../kube/kube-client.factory.js';
import { StoreService } from '../store/store.service.js';

const LEASE_NAME = 'capi-navigator-audit-cleanup';
const INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;
const LEASE_SECONDS = 15 * 60;

/**
 * Deletes AuditEvents older than the retention period (default 90 days, section 4). With more
 * than one replica, a Lease makes sure only one replica cleans up at a time.
 */
@Injectable()
export class AuditCleanupService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AuditCleanupService.name);
  private readonly leases: CoordinationV1Api;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    kube: KubeClientFactory,
    private readonly store: StoreService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.leases = kube.homeCluster().makeApiClient(CoordinationV1Api);
  }

  onApplicationBootstrap(): void {
    const run = () => void this.runOnce().catch((err: unknown) => this.logger.warn(String(err)));
    const first = setTimeout(run, FIRST_RUN_DELAY_MS);
    const every = setInterval(run, INTERVAL_MS);
    first.unref();
    every.unref();
    this.timers = [first, every];
  }

  onApplicationShutdown(): void {
    this.timers.forEach((t) => clearTimeout(t));
  }

  /** Returns the number of deleted events, or undefined if another replica holds the lease. */
  async runOnce(now = new Date()): Promise<number | undefined> {
    if (!(await this.acquireLease(now))) return undefined;
    const cutoff = new Date(now.getTime() - this.config.AUDIT_RETENTION_DAYS * 86_400_000);
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.store.auditEvents.list({ limit: 500, _continue: token });
      for (const ev of page.items) {
        if (new Date(ev.spec.timestamp) < cutoff) {
          await this.store.auditEvents.delete(ev.metadata.name).catch((err: unknown) => {
            if (!isNotFound(err)) throw err;
          });
          deleted++;
        }
      }
      token = page.continue;
    } while (token);
    if (deleted > 0)
      this.logger.log(`Deleted ${deleted} AuditEvent(s) older than ${cutoff.toISOString()}`);
    return deleted;
  }

  private async acquireLease(now: Date): Promise<boolean> {
    const namespace = this.store.namespace;
    const me = this.config.POD_NAME;
    const spec = {
      holderIdentity: me,
      leaseDurationSeconds: LEASE_SECONDS,
      renewTime: new V1MicroTime(now.getTime()),
    };
    let lease: V1Lease;
    try {
      lease = await this.leases.readNamespacedLease({ name: LEASE_NAME, namespace });
    } catch (err) {
      if (!isNotFound(err)) throw err;
      try {
        await this.leases.createNamespacedLease({
          namespace,
          body: { metadata: { name: LEASE_NAME, namespace }, spec },
        });
        return true;
      } catch (createErr) {
        if (isConflict(createErr)) return false;
        throw createErr;
      }
    }
    const holder = lease.spec?.holderIdentity;
    const renew = lease.spec?.renewTime ? new Date(lease.spec.renewTime).getTime() : 0;
    const duration = (lease.spec?.leaseDurationSeconds ?? LEASE_SECONDS) * 1000;
    if (holder && holder !== me && renew + duration > now.getTime()) return false;
    try {
      await this.leases.replaceNamespacedLease({
        name: LEASE_NAME,
        namespace,
        body: { ...lease, spec: { ...lease.spec, ...spec } },
      });
      return true;
    } catch (err) {
      if (isConflict(err)) return false;
      throw err;
    }
  }
}
