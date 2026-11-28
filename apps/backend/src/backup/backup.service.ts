import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import {
  BACKUP_S3_SECRET_NAME,
  BACKUP_SETTINGS_NAME,
  BackupSettingsInputSchema,
  MAX_BACKUP_RUNS,
  NAVIGATOR_API_VERSION,
  NavigatorBackupSettingsSpecSchema,
  nextBackupRuns,
  OIDC_CLIENT_SECRET_NAME,
  backupFileName,
  connectionSecretName,
  helmRepositorySecretName,
  managementBackupObjectPattern,
  managementBackupPrefix,
  passwordSecretName,
  type BackupPreview,
  type BackupRun,
  type BackupRunTarget,
  type BackupS3Credentials,
  type BackupS3TestRequest,
  type BackupS3TestResult,
  type BackupSettings,
  type BackupSettingsInput,
  type NavigatorBackupSettingsSpec,
  type NavigatorBackupSettingsStatus,
  type NavigatorResource,
} from '@capi-navigator/shared';
import type * as openpgp from 'openpgp';
import type { z } from 'zod';
import { SESSION_KEY_SECRET } from '../auth/session.service.js';
import { toHttpException } from '../kube/errors.js';
import type { CustomResourceClient } from '../store/custom-resource.client.js';
import { StoreService } from '../store/store.service.js';
import { APP_VERSION } from '../version.js';
import {
  buildBackupEntries,
  cleanObject,
  packArchive,
  type BackupGroup,
  type StoredObject,
} from './backup-archive.js';
import { explainS3, sdkS3, testTarget, uploadBackup, type S3Factory } from './backup-s3.js';
import { ManagementBackupService } from './management-backup.service.js';
import {
  BackupKeyError,
  describeRecipientKey,
  encryptTo,
  readRecipientKey,
} from './backup-keys.js';

const DEFAULT_SPEC: NavigatorBackupSettingsSpec = NavigatorBackupSettingsSpecSchema.parse({});

/** Injection token of the S3 client factory; tests pass a fake. */
export const BACKUP_S3_FACTORY = 'BACKUP_S3_FACTORY';

/** A finished backup: ciphertext only (FP38-F-05). */
export interface Backup {
  fileName: string;
  data: Uint8Array;
  /** For the AuditEvent (FP38-F-07): counts and fingerprints, never content. */
  summary: string;
}

/**
 * Backup of the home cluster (FP-38): settings, preview and the encrypted archive. The archive is
 * built and encrypted in memory; plaintext never leaves this service.
 */
@Injectable()
export class BackupService {
  private readonly s3: S3Factory;

  constructor(
    private readonly store: StoreService,
    @Optional() @Inject(BACKUP_S3_FACTORY) s3?: S3Factory,
    @Optional() private readonly management?: ManagementBackupService,
  ) {
    this.s3 = s3 ?? sdkS3;
  }

  async settings(now = new Date()): Promise<BackupSettings> {
    const stored = await this.stored();
    const spec = stored?.spec ?? DEFAULT_SPEC;
    const status = (stored?.status ?? {}) as NavigatorBackupSettingsStatus;
    const credentials = spec.s3 ? await this.s3Credentials() : undefined;
    return {
      recipients: await Promise.all(
        spec.recipients.map((r) => describeRecipientKey(r.publicKey, now)),
      ),
      includeAuditEvents: spec.includeAuditEvents,
      schedule: spec.schedule,
      s3: spec.s3 ? { ...spec.s3, credentialsSet: !!credentials } : null,
      nextRun:
        spec.schedule.enabled && spec.s3
          ? (nextBackupRuns(spec.schedule.cron, now)[0]?.toISOString() ?? null)
          : null,
      runs: status.runs ?? [],
      managementClusters: spec.managementClusters,
    };
  }

  /**
   * FP38-F-02, F-10: every key is checked; the same key twice is stored once. A new S3 access key
   * replaces the stored one; without a target the key is removed.
   */
  async updateSettings(body: BackupSettingsInput): Promise<BackupSettings> {
    const parsed = BackupSettingsInputSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestException({
        statusCode: 400,
        message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid backup settings',
      });
    }
    const input = parsed.data;
    const seen = new Set<string>();
    const recipients: NavigatorBackupSettingsSpec['recipients'] = [];
    for (const [i, r] of input.recipients.entries()) {
      const key = await this.checkedKey(r.publicKey, i);
      const fp = key.getFingerprint();
      if (seen.has(fp)) continue;
      seen.add(fp);
      recipients.push({ publicKey: r.publicKey });
    }
    const spec: NavigatorBackupSettingsSpec = {
      recipients,
      includeAuditEvents: input.includeAuditEvents,
      schedule: input.schedule,
      ...(input.s3 ? { s3: input.s3 } : {}),
      managementClusters: input.managementClusters,
    };
    const unknown = spec.managementClusters.filter((c) => !this.store.connectionCache.get(c));
    if (unknown.length) {
      throw new BadRequestException({
        statusCode: 400,
        message: `Unknown management cluster connection: ${unknown.join(', ')}`,
        hint: 'Choose connections from the Connections page.',
      });
    }
    if (input.s3 && !input.s3Credentials && !(await this.s3Credentials())) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Enter the S3 access key',
        hint: 'The S3 target needs an access key ID and a secret access key.',
      });
    }
    if (spec.schedule.enabled && (!spec.s3 || recipients.length === 0)) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'A schedule needs an S3 target and at least one key',
        hint: 'Set the S3 target and add a recipient key, or switch the schedule off.',
      });
    }
    try {
      if (input.s3Credentials) {
        await this.store.secrets.put(BACKUP_S3_SECRET_NAME, input.s3Credentials);
      } else if (!input.s3) {
        await this.store.secrets.delete(BACKUP_S3_SECRET_NAME);
      }
      const current = await this.store.backupSettings.get(BACKUP_SETTINGS_NAME);
      if (current) await this.store.backupSettings.replaceSpec(current, spec);
      else
        await this.store.backupSettings.create(
          {
            name: BACKUP_SETTINGS_NAME,
            labels: { 'app.kubernetes.io/part-of': 'capi-navigator' },
          },
          spec,
        );
    } catch (err) {
      throw toHttpException(err, 'Save the backup settings');
    }
    return this.settings();
  }

  /** FP38-F-14: tests the target as entered, with a new key or the stored one. */
  async testS3(req: BackupS3TestRequest): Promise<BackupS3TestResult> {
    const credentials = req.s3Credentials ?? (await this.s3Credentials());
    if (!credentials) {
      return {
        ok: false,
        message: 'No S3 access key',
        hint: 'Enter the access key ID and the secret access key.',
      };
    }
    return testTarget(this.s3(req.s3, credentials), req.s3);
  }

  /**
   * FP38-F-11 to F-13, FP39-F-11 to F-13: backs up the home cluster and every listed management
   * cluster, uploads each to its folder, applies the retention per folder and records the run in
   * the status (newest first). Every target succeeds or fails on its own; S3 errors never throw:
   * the run says what failed.
   */
  async runToS3(
    trigger: BackupRun['trigger'],
    actor: string,
    now = () => new Date(),
  ): Promise<{ run: BackupRun; summary?: string }> {
    const startedAt = now().toISOString();
    const stored = await this.stored();
    const spec = stored?.spec ?? DEFAULT_SPEC;
    const finish = async (run: Omit<BackupRun, 'startedAt' | 'finishedAt' | 'trigger'>) => {
      const full: BackupRun = { startedAt, finishedAt: now().toISOString(), trigger, ...run };
      await this.recordRun(full);
      return full;
    };
    const credentials = spec.s3 ? await this.s3Credentials() : undefined;
    if (!spec.s3 || !credentials) {
      return {
        run: await finish({
          outcome: 'failure',
          message: 'No S3 target set',
          hint: 'Set the S3 target and its access key on the backup page.',
        }),
      };
    }
    const target = spec.s3;
    const s3 = this.s3(target, credentials);
    const at = new Date(startedAt);
    const summaries: string[] = [];
    const uploaded = (summary: string, key: string, deleted: string[]) =>
      summaries.push(
        `${summary}; uploaded to ${target.bucket}/${key}${deleted.length ? `, ${deleted.length} older deleted` : ''}`,
      );

    const home = await attempt(async () => {
      const backup = await this.create(actor, at);
      const { key, deleted } = await uploadBackup(
        s3,
        target,
        backup.fileName,
        backup.data,
        spec.schedule.keep,
      );
      uploaded(backup.summary, key, deleted);
      return { objectKey: key, size: backup.data.length, deleted: deleted.length };
    });

    const targets: BackupRunTarget[] = [];
    const management = this.management;
    if (management && spec.managementClusters.length) {
      // Without usable keys every management cluster fails with the same reason.
      let keys: openpgp.Key[] = [];
      let keyFailure: Failure | undefined;
      try {
        keys = await this.recipientKeys();
      } catch (err) {
        keyFailure = failureOf(err);
      }
      for (const connection of spec.managementClusters) {
        const result =
          keyFailure ??
          (await attempt(async () => {
            const backup = await management.create(connection, actor, keys, at);
            const { key, deleted } = await uploadBackup(
              s3,
              target,
              backup.fileName,
              backup.data,
              spec.schedule.keep,
              {
                prefix: managementBackupPrefix(target.prefix, connection),
                pattern: managementBackupObjectPattern(connection),
              },
            );
            uploaded(backup.summary, key, deleted);
            return { objectKey: key, size: backup.data.length, deleted: deleted.length };
          }));
        targets.push({ connection, ...result });
      }
    }

    const failed = targets.filter((t) => t.outcome === 'failure');
    const run = await finish({
      ...home,
      outcome: home.outcome === 'failure' || failed.length ? 'failure' : 'success',
      ...(home.outcome === 'success' && failed.length
        ? {
            message: `${failed.length} of ${targets.length} management ${targets.length === 1 ? 'cluster' : 'clusters'} failed: ${failed.map((f) => f.connection).join(', ')}`,
            hint: 'The home cluster was backed up; see the management clusters of this run.',
          }
        : {}),
      ...(targets.length ? { targets } : {}),
    });
    return { run, ...(summaries.length ? { summary: summaries.join(' | ') } : {}) };
  }

  /** The due time of the last scheduled run (FP38-F-11). */
  async lastScheduledAt(): Promise<string | undefined> {
    const status = (await this.stored())?.status as NavigatorBackupSettingsStatus | undefined;
    return status?.lastScheduledAt;
  }

  async setLastScheduledAt(at: string): Promise<void> {
    await this.store.backupSettings.patchStatus(BACKUP_SETTINGS_NAME, { lastScheduledAt: at });
  }

  /** The stored settings, for the scheduler. */
  async storedSpec(): Promise<NavigatorBackupSettingsSpec> {
    return (await this.stored())?.spec ?? DEFAULT_SPEC;
  }

  private async recordRun(run: BackupRun): Promise<void> {
    const stored = await this.stored();
    if (!stored) return;
    const runs = ((stored.status as NavigatorBackupSettingsStatus | undefined)?.runs ?? []).slice(
      0,
      MAX_BACKUP_RUNS - 1,
    );
    await this.store.backupSettings.patchStatus(BACKUP_SETTINGS_NAME, { runs: [run, ...runs] });
  }

  private async s3Credentials(): Promise<BackupS3Credentials | undefined> {
    const data = await this.store.secrets.get(BACKUP_S3_SECRET_NAME);
    return data?.accessKeyId && data.secretAccessKey
      ? { accessKeyId: data.accessKeyId, secretAccessKey: data.secretAccessKey }
      : undefined;
  }

  /** FP38-F-03: what a backup would contain now, by kind. */
  async preview(): Promise<BackupPreview> {
    const spec = await this.storedSpec();
    const groups = await this.collect(spec.includeAuditEvents);
    const items = groups.map((g) => ({ kind: g.kind, count: g.objects.length }));
    return {
      items,
      total: items.reduce((n, i) => n + i.count, 0),
      recipients: spec.recipients.length,
      includeAuditEvents: spec.includeAuditEvents,
      namespace: this.store.namespace,
      appVersion: APP_VERSION,
    };
  }

  /**
   * The recipient keys, each checked again (FP38-F-02); also for the management cluster backups
   * (FP39-F-01). Refuses without a key.
   */
  async recipientKeys(): Promise<openpgp.Key[]> {
    const spec = await this.storedSpec();
    if (spec.recipients.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'No backup key is set',
        hint: 'Add the OpenPGP public key of at least one recipient on the backup page first.',
      });
    }
    const keys: openpgp.Key[] = [];
    for (const [i, r] of spec.recipients.entries())
      keys.push(await this.checkedKey(r.publicKey, i));
    return keys;
  }

  /** FP38-F-04, F-05: the encrypted archive. */
  async create(createdBy: string, now = new Date()): Promise<Backup> {
    const spec = await this.storedSpec();
    const keys = await this.recipientKeys();
    const fingerprints = keys.map((k) => k.getFingerprint().toUpperCase());
    const groups = await this.collect(spec.includeAuditEvents);
    const entries = buildBackupEntries({
      createdAt: now,
      createdBy,
      appVersion: APP_VERSION,
      namespace: this.store.namespace,
      includesAuditEvents: spec.includeAuditEvents,
      recipients: fingerprints,
      groups,
    });
    const data = await encryptTo(await packArchive(entries, now), keys);
    const total = groups.reduce((n, g) => n + g.objects.length, 0);
    return {
      fileName: backupFileName(now),
      data,
      summary: `${total} objects, encrypted to ${fingerprints.join(', ')}`,
    };
  }

  private async stored() {
    try {
      return await this.store.backupSettings.get(BACKUP_SETTINGS_NAME);
    } catch (err) {
      throw toHttpException(err, 'Read the backup settings');
    }
  }

  private async checkedKey(armored: string, index: number): Promise<openpgp.Key> {
    try {
      return await readRecipientKey(armored);
    } catch (err) {
      if (!(err instanceof BackupKeyError)) throw err;
      throw new BadRequestException({
        statusCode: 400,
        message: `Key ${index + 1}: ${err.message}`,
        hint: 'Replace or remove this key on the backup page.',
      });
    }
  }

  /**
   * FP38-F-03: the app's objects in restore order. Secrets are read one by one by the names the app
   * gives them (from its own resources), never "every Secret in the namespace", which the app's
   * Role does not allow either; the initial admin password, Leases and the chart's objects are not
   * part of it.
   */
  private async collect(includeAuditEvents: boolean): Promise<BackupGroup[]> {
    try {
      const s = this.store;
      const [connections, repositories, roles, groups, users, tokens, auth, backup, blueprints] =
        await Promise.all([
          listAll(s.connections),
          listAll(s.helmRepositories),
          listAll(s.roles),
          listAll(s.groups),
          listAll(s.users),
          listAll(s.tokens),
          listAll(s.authSettings),
          listAll(s.backupSettings),
          listAll(s.blueprints),
        ]);
      const audit = includeAuditEvents ? await listAll(s.auditEvents) : [];
      const secretNames = new Set([
        SESSION_KEY_SECRET,
        OIDC_CLIENT_SECRET_NAME,
        BACKUP_S3_SECRET_NAME,
        ...connections.map((c) => connectionSecretName(c.metadata.name)),
        ...users.map((u) => passwordSecretName(u.metadata.name)),
        ...repositories.map((r) => helmRepositorySecretName(r.metadata.name)),
      ]);
      const secrets = (
        await Promise.all([...secretNames].map((name) => s.secrets.getRaw(name)))
      ).filter((x) => x !== undefined);
      const presets = await s.addonPresetOverridesConfigMap();
      const cr = (
        kind: string,
        file: string,
        items: NavigatorResource<unknown>[],
      ): BackupGroup => ({
        kind,
        file,
        objects: items.map((o) => cleanObject(o as StoredObject, NAVIGATOR_API_VERSION, kind)),
      });
      return [
        {
          kind: 'Secret',
          file: 'secrets',
          objects: secrets.map((x) => cleanObject(x as StoredObject, 'v1', 'Secret')),
        },
        {
          kind: 'ConfigMap',
          file: 'configmaps',
          objects: presets ? [cleanObject(presets as StoredObject, 'v1', 'ConfigMap')] : [],
        },
        cr('ManagementCluster', 'managementclusters', connections),
        cr('HelmRepository', 'helmrepositories', repositories),
        cr('NavigatorRole', 'navigatorroles', roles),
        cr('NavigatorGroup', 'navigatorgroups', groups),
        cr('NavigatorUser', 'navigatorusers', users),
        cr('NavigatorToken', 'navigatortokens', tokens),
        cr('NavigatorAuthSettings', 'navigatorauthsettings', auth),
        cr('NavigatorBackupSettings', 'navigatorbackupsettings', backup),
        cr('ClusterBlueprint', 'clusterblueprints', blueprints),
        ...(includeAuditEvents ? [cr('AuditEvent', 'auditevents', audit)] : []),
      ];
    } catch (err) {
      throw toHttpException(err, 'Read the app data for the backup');
    }
  }
}

/** All resources of one CRD, page by page. */
async function listAll<S extends z.ZodType>(
  client: CustomResourceClient<S>,
): Promise<NavigatorResource<z.infer<S>>[]> {
  const out: NavigatorResource<z.infer<S>>[] = [];
  let token: string | undefined;
  do {
    const page = await client.list({ limit: 500, ...(token ? { _continue: token } : {}) });
    out.push(...page.items);
    token = page.continue;
  } while (token);
  return out;
}

interface Failure {
  outcome: 'failure';
  message: string;
  hint?: string;
}
type Attempt<T> = ({ outcome: 'success' } & T) | Failure;

/**
 * An error as the failure of one part of an S3 run: the app's own (HTTP) errors keep their message
 * and hint, S3 errors are explained (NF-06).
 */
function failureOf(err: unknown): Failure {
  const body = (err as { response?: { message?: unknown; hint?: unknown } }).response;
  if (body && typeof body.message === 'string') {
    return {
      outcome: 'failure',
      message: body.message,
      ...(typeof body.hint === 'string' ? { hint: body.hint } : {}),
    };
  }
  const { message, hint } = explainS3(err, 'upload');
  return { outcome: 'failure', message, ...(hint ? { hint } : {}) };
}

/** Runs one part of an S3 run; an error becomes its failure. */
async function attempt<T extends object>(fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { outcome: 'success', ...(await fn()) };
  } catch (err) {
    return failureOf(err);
  }
}
