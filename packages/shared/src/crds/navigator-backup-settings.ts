import { Cron } from 'croner';
import { z } from 'zod';
import { ConnectionNameSchema } from '../connections.js';
import type { CrdDefinition } from './types.js';

/** The only NavigatorBackupSettings resource (FP38-F-01). */
export const BACKUP_SETTINGS_NAME = 'default';

/** At most this many recipients; every backup is encrypted to each of them (FP38-F-02). */
export const MAX_BACKUP_RECIPIENTS = 10;

/**
 * An OpenPGP public key, ASCII-armored. Whether it can encrypt is checked in the backend
 * (FP38-F-02); a private key never gets past it.
 */
export const BackupPublicKeySchema = z
  .string()
  .trim()
  .max(64 * 1024, 'The key is too large')
  .refine((k) => !k.includes('PRIVATE KEY BLOCK'), {
    error:
      'This is a private key. Paste only the public key (gpg --armor --export KEY-ID) and keep the private key offline.',
    abort: true,
  })
  .refine((k) => k.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----'), {
    error: 'Paste an ASCII-armored OpenPGP public key (gpg --armor --export <key ID>)',
  });

/** Secret with the S3 access key of scheduled backups (FP38-F-10); never returned. */
export const BACKUP_S3_SECRET_NAME = 'capi-navigator-backup-s3';

/**
 * A cron expression with five fields (minute, hour, day of month, month, day of week), read in UTC
 * (FP38-F-10), e.g. "0 3 * * *" for 03:00 UTC every day.
 */
export const BackupCronSchema = z
  .string()
  .trim()
  .refine((v) => v.split(/\s+/).length === 5, {
    error: 'Use five fields: minute hour day-of-month month day-of-week, e.g. 0 3 * * *',
  })
  .refine((v) => cronProblem(v) === undefined, {
    error: 'Not a valid cron expression, e.g. 0 3 * * * for 03:00 UTC every day',
  });

/** FP38-F-10: when scheduled backups run, and how many the app keeps (FP38-F-12). */
export const BackupScheduleSchema = z.object({
  enabled: z.boolean().default(false),
  cron: BackupCronSchema.default('0 3 * * *'),
  keep: z.number().int().min(1, 'Keep at least 1').max(365, 'At most 365').default(14),
});
export type BackupSchedule = z.infer<typeof BackupScheduleSchema>;

/** FP38-F-10: the S3 target; S3-compatible storage through endpoint and path-style addressing. */
export const BackupS3TargetSchema = z.object({
  bucket: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Enter an S3 bucket name, e.g. my-backups'),
  /** Key prefix; the app writes and deletes only below it. */
  prefix: z
    .string()
    .trim()
    .max(200)
    .regex(/^([A-Za-z0-9!_.*'()-]+\/)*$/, 'A path ending with /, e.g. capi-navigator/ (or empty)')
    .default('capi-navigator/'),
  region: z.string().trim().min(1).max(64).default('us-east-1'),
  /** For S3-compatible storage, e.g. https://minio.example.com:9000; empty for AWS. */
  endpoint: z
    .url({ protocol: /^https?$/, error: 'Enter a URL, e.g. https://minio.example.com' })
    .optional(),
  forcePathStyle: z.boolean().default(false),
  /** PEM CA certificate of the endpoint, if it is not publicly trusted. */
  caCertificate: z
    .string()
    .trim()
    .max(64 * 1024)
    .refine((v) => v.includes('-----BEGIN CERTIFICATE-----'), { error: 'Paste a PEM certificate' })
    .optional(),
  /**
   * Skip the certificate check of the endpoint, e.g. for a self-signed test setup (as for OCI
   * Helm repositories). Not recommended: the CA certificate keeps the check. The backup stays
   * encrypted either way; the access key signs requests but is never sent.
   */
  insecureSkipTLSVerify: z.boolean().default(false),
});
export type BackupS3Target = z.infer<typeof BackupS3TargetSchema>;

export const NavigatorBackupSettingsSpecSchema = z.object({
  recipients: z
    .array(z.object({ publicKey: BackupPublicKeySchema }))
    .max(MAX_BACKUP_RECIPIENTS, `At most ${MAX_BACKUP_RECIPIENTS} keys`)
    .default([]),
  /** FP38-F-01: the audit history is part of the backup unless switched off. */
  includeAuditEvents: z.boolean().default(true),
  schedule: BackupScheduleSchema.default({ enabled: false, cron: '0 3 * * *', keep: 14 }),
  s3: BackupS3TargetSchema.optional(),
  /**
   * FP39-F-11: management connections whose clusters every S3 run backs up too, each to
   * `<prefix>mgmt/<connection>/`. Default: none.
   */
  managementClusters: z
    .array(ConnectionNameSchema)
    .max(50)
    .refine((l) => new Set(l).size === l.length, { error: 'Each connection only once' })
    .default([]),
});
export type NavigatorBackupSettingsSpec = z.infer<typeof NavigatorBackupSettingsSpecSchema>;

/** FP39-F-13: the result of one management cluster in an S3 run. */
export const BackupRunTargetSchema = z.object({
  connection: z.string(),
  outcome: z.enum(['success', 'failure']),
  objectKey: z.string().optional(),
  size: z.number().int().optional(),
  deleted: z.number().int().optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
});
export type BackupRunTarget = z.infer<typeof BackupRunTargetSchema>;

/**
 * One backup to S3 (FP38-F-13). The top-level result is that of the home cluster; `targets` holds
 * the management clusters (FP39-F-13). `outcome` is a failure if any of them failed.
 */
export const BackupRunSchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string(),
  trigger: z.enum(['schedule', 'manual']),
  outcome: z.enum(['success', 'failure']),
  objectKey: z.string().optional(),
  size: z.number().int().optional(),
  /** Older backups deleted by the retention (FP38-F-12). */
  deleted: z.number().int().optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
  targets: z.array(BackupRunTargetSchema).optional(),
});
export type BackupRun = z.infer<typeof BackupRunSchema>;

/** At most this many runs are kept in the status. */
export const MAX_BACKUP_RUNS = 10;

export const NavigatorBackupSettingsStatusSchema = z.object({
  /**
   * The due time the last scheduled run belonged to (FP38-F-11): a replica runs only when the
   * schedule's last due time is later, so every due time runs once across replicas and restarts.
   */
  lastScheduledAt: z.string().optional(),
  runs: z.array(BackupRunSchema).max(MAX_BACKUP_RUNS).optional(),
});
export type NavigatorBackupSettingsStatus = z.infer<typeof NavigatorBackupSettingsStatusSchema>;

export const NavigatorBackupSettingsCrd: CrdDefinition<
  typeof NavigatorBackupSettingsSpecSchema,
  typeof NavigatorBackupSettingsStatusSchema
> = {
  kind: 'NavigatorBackupSettings',
  plural: 'navigatorbackupsettings',
  singular: 'navigatorbackupsetting',
  shortNames: ['navbackup'],
  scope: 'Namespaced',
  spec: NavigatorBackupSettingsSpecSchema,
  status: NavigatorBackupSettingsStatusSchema,
  printerColumns: [
    { name: 'Audit events', type: 'boolean', jsonPath: '.spec.includeAuditEvents' },
    { name: 'Schedule', type: 'string', jsonPath: '.spec.schedule.cron' },
    { name: 'Bucket', type: 'string', jsonPath: '.spec.s3.bucket' },
    { name: 'Last scheduled', type: 'string', jsonPath: '.status.lastScheduledAt' },
    { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
  ],
};

const cron = (expr: string) => new Cron(expr.trim(), { timezone: 'UTC', paused: true });

/** Why a cron expression cannot be used, or undefined (read in UTC). */
export function cronProblem(expr: string): string | undefined {
  try {
    cron(expr);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The next `n` times a schedule is due after `from` (FP38-F-10). */
export function nextBackupRuns(expr: string, from: Date, n = 1): Date[] {
  return cron(expr).nextRuns(n, from);
}

/** The last time a schedule was due at or before `now`; undefined if never (FP38-F-11). */
export function lastBackupDue(expr: string, now: Date): Date | undefined {
  // previousRuns leaves out the reference itself; one millisecond later includes a run at `now`.
  return cron(expr).previousRuns(1, new Date(now.getTime() + 1))[0];
}
