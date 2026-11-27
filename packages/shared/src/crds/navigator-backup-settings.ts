import { z } from 'zod';
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
  .refine((k) => k.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----'), {
    error: 'Paste an ASCII-armored OpenPGP public key (gpg --armor --export <key ID>)',
  });

export const NavigatorBackupSettingsSpecSchema = z.object({
  recipients: z
    .array(z.object({ publicKey: BackupPublicKeySchema }))
    .max(MAX_BACKUP_RECIPIENTS, `At most ${MAX_BACKUP_RECIPIENTS} keys`)
    .default([]),
  /** FP38-F-01: the audit history is part of the backup unless switched off. */
  includeAuditEvents: z.boolean().default(true),
});
export type NavigatorBackupSettingsSpec = z.infer<typeof NavigatorBackupSettingsSpecSchema>;

export const NavigatorBackupSettingsCrd: CrdDefinition<typeof NavigatorBackupSettingsSpecSchema> = {
  kind: 'NavigatorBackupSettings',
  plural: 'navigatorbackupsettings',
  singular: 'navigatorbackupsetting',
  shortNames: ['navbackup'],
  scope: 'Namespaced',
  spec: NavigatorBackupSettingsSpecSchema,
  printerColumns: [
    { name: 'Audit events', type: 'boolean', jsonPath: '.spec.includeAuditEvents' },
    { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
  ],
};
