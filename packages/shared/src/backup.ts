import { z } from 'zod';
import { NavigatorBackupSettingsSpecSchema } from './crds/navigator-backup-settings.js';

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
});
export type BackupSettings = z.infer<typeof BackupSettingsSchema>;

/** PUT body of the backup settings: the CRD spec. */
export const BackupSettingsInputSchema = NavigatorBackupSettingsSpecSchema;
export type BackupSettingsInput = z.infer<typeof BackupSettingsInputSchema>;

/** FP38-F-03: what a backup would contain now, by kind; nothing of the content itself. */
export const BackupPreviewSchema = z.object({
  items: z.array(z.object({ kind: z.string(), count: z.number().int() })),
  total: z.number().int(),
  recipients: z.number().int(),
  includeAuditEvents: z.boolean(),
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
