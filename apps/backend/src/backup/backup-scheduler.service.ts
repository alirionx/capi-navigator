import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { CoordinationV1Api } from '@kubernetes/client-node';
import { lastBackupDue, type NavigatorBackupSettingsSpec } from '@capi-navigator/shared';
import { AuditService } from '../audit/audit.service.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { acquireLease } from '../kube/lease.js';
import { KubeClientFactory } from '../kube/kube-client.factory.js';
import { StoreService } from '../store/store.service.js';
import { BackupService } from './backup.service.js';

const LEASE_NAME = 'capi-navigator-backup';
const TICK_MS = 30 * 1000;
/** Longer than a tick and a backup, shorter than the gap between two runs of a sane schedule. */
const LEASE_SECONDS = 5 * 60;
/** A due time older than this when noticed was missed (app down) and is skipped (FP38-F-11). */
export const MISSED_AFTER_MS = 10 * 60 * 1000;

export type Decision =
  { action: 'none' } | { action: 'skip'; due: Date } | { action: 'run'; due: Date };

/**
 * FP38-F-11, a pure function: what to do now. A due time runs once: only when it is later than
 * the one recorded in the status. A due time noticed too late (the app was down) is recorded as
 * done without a backup; the next one runs on schedule.
 */
export function decide(
  spec: Pick<NavigatorBackupSettingsSpec, 'schedule' | 's3' | 'recipients'>,
  lastScheduledAt: string | undefined,
  now: Date,
): Decision {
  if (!spec.schedule.enabled || !spec.s3 || spec.recipients.length === 0) return { action: 'none' };
  const due = lastBackupDue(spec.schedule.cron, now);
  if (!due) return { action: 'none' };
  if (lastScheduledAt && due.getTime() <= new Date(lastScheduledAt).getTime())
    return { action: 'none' };
  return now.getTime() - due.getTime() > MISSED_AFTER_MS
    ? { action: 'skip', due }
    : { action: 'run', due };
}

/**
 * Scheduled backups to S3 (FP38-F-11): every replica ticks, the one holding the Lease decides and
 * runs. The due time is recorded before the backup starts, so a replica taking over the Lease
 * does not run it again.
 */
@Injectable()
export class BackupSchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BackupSchedulerService.name);
  private readonly leases: CoordinationV1Api;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    kube: KubeClientFactory,
    private readonly store: StoreService,
    private readonly backup: BackupService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.leases = kube.homeCluster().makeApiClient(CoordinationV1Api);
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One check; returns what was done (for tests). */
  async tick(now = new Date()): Promise<Decision['action'] | 'not-leader' | 'busy'> {
    if (this.running) return 'busy';
    this.running = true;
    try {
      const spec = await this.backup.storedSpec();
      if (!spec.schedule.enabled) return 'none';
      const leader = await acquireLease(
        this.leases,
        {
          namespace: this.store.namespace,
          name: LEASE_NAME,
          holder: this.config.POD_NAME,
          durationSeconds: LEASE_SECONDS,
        },
        now,
      );
      if (!leader) return 'not-leader';
      const decision = decide(spec, await this.backup.lastScheduledAt(), now);
      if (decision.action === 'none') return 'none';
      await this.backup.setLastScheduledAt(decision.due.toISOString());
      if (decision.action === 'skip') {
        this.logger.warn(
          `Skipped the scheduled backup of ${decision.due.toISOString()}: noticed too late (the app was not running); the next one runs on schedule`,
        );
        return 'skip';
      }
      const { run, summary } = await this.backup.runToS3('schedule', 'scheduler');
      await this.audit.record({
        actor: 'scheduler',
        action: 'backup.s3.scheduled',
        outcome: run.outcome,
        target: { kind: 'NavigatorBackupSettings', name: 'default' },
        ...((summary ?? run.message) ? { message: summary ?? run.message } : {}),
      });
      if (run.outcome === 'failure')
        this.logger.warn(`Scheduled backup failed: ${run.message ?? 'unknown error'}`);
      return 'run';
    } catch (err) {
      this.logger.warn(`Backup schedule: ${err instanceof Error ? err.message : String(err)}`);
      return 'none';
    } finally {
      this.running = false;
    }
  }
}
