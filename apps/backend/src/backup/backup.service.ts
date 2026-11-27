import { BadRequestException, Injectable } from '@nestjs/common';
import {
  BACKUP_SETTINGS_NAME,
  NAVIGATOR_API_VERSION,
  NavigatorBackupSettingsSpecSchema,
  OIDC_CLIENT_SECRET_NAME,
  backupFileName,
  connectionSecretName,
  helmRepositorySecretName,
  passwordSecretName,
  type BackupPreview,
  type BackupSettings,
  type BackupSettingsInput,
  type NavigatorBackupSettingsSpec,
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
import {
  BackupKeyError,
  describeRecipientKey,
  encryptTo,
  readRecipientKey,
} from './backup-keys.js';

const DEFAULT_SPEC: NavigatorBackupSettingsSpec = NavigatorBackupSettingsSpecSchema.parse({});

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
  constructor(private readonly store: StoreService) {}

  async settings(now = new Date()): Promise<BackupSettings> {
    const spec = await this.storedSpec();
    return {
      recipients: await Promise.all(
        spec.recipients.map((r) => describeRecipientKey(r.publicKey, now)),
      ),
      includeAuditEvents: spec.includeAuditEvents,
    };
  }

  /** FP38-F-02: every key is checked; the same key twice is stored once. */
  async updateSettings(input: BackupSettingsInput): Promise<BackupSettings> {
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
    };
    try {
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
    };
  }

  /** FP38-F-04, F-05: the encrypted archive. */
  async create(createdBy: string, now = new Date()): Promise<Backup> {
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

  private async storedSpec(): Promise<NavigatorBackupSettingsSpec> {
    try {
      return (await this.store.backupSettings.get(BACKUP_SETTINGS_NAME))?.spec ?? DEFAULT_SPEC;
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
   * FP38-F-03: the app's objects in restore order. Secrets are taken by the names the app gives
   * them (from its own resources), never "every Secret in the namespace"; the initial admin
   * password, Leases and the chart's objects are not part of it.
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
        ...connections.map((c) => connectionSecretName(c.metadata.name)),
        ...users.map((u) => passwordSecretName(u.metadata.name)),
        ...repositories.map((r) => helmRepositorySecretName(r.metadata.name)),
      ]);
      const secrets = (await s.secrets.listRaw()).filter((x) =>
        secretNames.has(x.metadata?.name ?? ''),
      );
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
