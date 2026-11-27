import { z } from 'zod';
import {
  BackupRunSchema,
  BackupS3TargetSchema,
  BackupScheduleSchema,
  NavigatorBackupSettingsSpecSchema,
} from './crds/navigator-backup-settings.js';

/** A recipient key as shown on the backup page (FP38-F-02); public data only. */
export const BackupKeySchema = z.object({
  publicKey: z.string(),
  /** Upper-case hex, as printed by `gpg --fingerprint` without spaces. */
  fingerprint: z.string(),
  userIds: z.array(z.string()),
  createdAt: z.string(),
  /** ISO time; null if the key does not expire. */
  expiresAt: z.string().nullable(),
  /** FP38-F-02: the key expires within 30 days. */
  expiresSoon: z.boolean(),
  /** Why a stored key can no longer encrypt (e.g. expired since it was added); blocks backups. */
  problem: z.string().optional(),
});
export type BackupKey = z.infer<typeof BackupKeySchema>;

export const BackupSettingsSchema = z.object({
  recipients: z.array(BackupKeySchema),
  includeAuditEvents: z.boolean(),
  schedule: BackupScheduleSchema,
  /** The S3 target; the access key is never returned, only whether one is set (FP38-F-10). */
  s3: BackupS3TargetSchema.extend({ credentialsSet: z.boolean() }).nullable(),
  /** Next scheduled run (ISO), if the schedule is on and a target is set. */
  nextRun: z.string().nullable(),
  /** FP38-F-13: the last runs to S3, newest first. */
  runs: z.array(BackupRunSchema),
});
export type BackupSettings = z.infer<typeof BackupSettingsSchema>;

/** S3 access key, write-only (FP38-F-10). */
export const BackupS3CredentialsSchema = z.object({
  accessKeyId: z.string().trim().min(1, 'Enter the access key ID').max(256),
  secretAccessKey: z.string().trim().min(1, 'Enter the secret access key').max(256),
});
export type BackupS3Credentials = z.infer<typeof BackupS3CredentialsSchema>;

/**
 * PUT body of the backup settings: the CRD spec, plus a new S3 access key. Without `s3Credentials`
 * the stored key is kept; without `s3` the target and its key are removed.
 */
export const BackupSettingsInputSchema = NavigatorBackupSettingsSpecSchema.extend({
  s3Credentials: BackupS3CredentialsSchema.optional(),
});
export type BackupSettingsInput = z.input<typeof BackupSettingsInputSchema>;

/** FP38-F-03: what a backup would contain now, by kind; nothing of the content itself. */
export const BackupPreviewSchema = z.object({
  items: z.array(z.object({ kind: z.string(), count: z.number().int() })),
  total: z.number().int(),
  recipients: z.number().int(),
  includeAuditEvents: z.boolean(),
  /** For the restore guide on the page (FP38-F-08): where and which version to restore. */
  namespace: z.string(),
  appVersion: z.string(),
});
export type BackupPreview = z.infer<typeof BackupPreviewSchema>;

/** Days before expiry from which a recipient key is flagged (FP38-F-02). */
export const BACKUP_KEY_WARN_DAYS = 30;

/** File name of a backup (FP38-F-04), e.g. capi-navigator-home-20261127T101500Z.tar.gz.gpg. */
export function backupFileName(at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `capi-navigator-home-${stamp}.tar.gz.gpg`;
}

/** Result of "Test connection" to the S3 target (FP38-F-14). */
export const BackupS3TestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  hint: z.string().optional(),
  details: z.string().optional(),
});
export type BackupS3TestResult = z.infer<typeof BackupS3TestResultSchema>;

/** Body of "Test connection": the target as entered, with a new key or the stored one. */
export const BackupS3TestRequestSchema = z.object({
  s3: BackupS3TargetSchema,
  s3Credentials: BackupS3CredentialsSchema.optional(),
});
export type BackupS3TestRequest = z.infer<typeof BackupS3TestRequestSchema>;

/** Object names the app writes to S3; retention deletes only these (FP38-F-12). */
export const BACKUP_OBJECT_PATTERN = /^capi-navigator-home-\d{8}T\d{6}Z\.tar\.gz\.gpg$/;
