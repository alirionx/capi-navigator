import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as openpgp from 'openpgp';
import { describe, expect, it } from 'vitest';
import { readFromChartArchive } from '../helm/chart-archive.js';
import { backupStore } from './backup.fixtures.js';
import { BackupService } from './backup.service.js';

async function recipient() {
  return openpgp.generateKey({
    type: 'curve25519',
    userIDs: [{ name: 'Ops', email: 'ops@example.com' }],
    format: 'armored',
  });
}

async function decrypt(data: Uint8Array, privateKey: string): Promise<Buffer> {
  const message = await openpgp.readMessage({ binaryMessage: data });
  const decryptionKeys = await openpgp.readPrivateKey({ armoredKey: privateKey });
  const { data: out } = await openpgp.decrypt({ message, decryptionKeys, format: 'binary' });
  return Buffer.from(out as Uint8Array);
}

describe('backup of the home cluster (FP-38)', () => {
  it('refuses a backup without a key', async () => {
    const svc = new BackupService(backupStore().store);
    await expect(svc.create('admin')).rejects.toMatchObject({
      response: { message: 'No backup key is set' },
    });
  });

  it('checks keys on save and stores the same key once (FP38-F-02)', async () => {
    const fake = backupStore();
    const svc = new BackupService(fake.store);
    const a = await recipient();
    await expect(
      svc.updateSettings({ recipients: [{ publicKey: a.privateKey }], includeAuditEvents: true }),
    ).rejects.toMatchObject({ response: { message: expect.stringMatching(/^Key 1: .*private/) } });
    const saved = await svc.updateSettings({
      recipients: [{ publicKey: a.publicKey }, { publicKey: a.publicKey }],
      includeAuditEvents: false,
    });
    expect(saved.recipients).toHaveLength(1);
    expect(saved.includeAuditEvents).toBe(false);
    expect(fake.settings()?.spec.recipients).toHaveLength(1);
  });

  it('previews the content by kind (FP38-F-03)', async () => {
    const svc = new BackupService(backupStore().store);
    const preview = await svc.preview();
    expect(Object.fromEntries(preview.items.map((i) => [i.kind, i.count]))).toEqual({
      Secret: 6,
      ConfigMap: 1,
      ManagementCluster: 2,
      HelmRepository: 1,
      NavigatorRole: 1,
      NavigatorGroup: 0,
      NavigatorUser: 2,
      NavigatorToken: 1,
      NavigatorAuthSettings: 1,
      NavigatorBackupSettings: 0,
      ClusterBlueprint: 1,
      AuditEvent: 2,
    });
    expect(preview.total).toBe(18);
    expect(preview).toMatchObject({
      namespace: 'capi-navigator-system',
      appVersion: expect.any(String),
    });
  });

  it('writes an encrypted archive with only the app objects (FP38-F-03 to F-05)', async () => {
    const fake = backupStore();
    const svc = new BackupService(fake.store);
    const a = await recipient();
    await svc.updateSettings({
      recipients: [{ publicKey: a.publicKey }],
      includeAuditEvents: false,
    });
    const backup = await svc.create('admin', new Date('2026-11-27T10:15:00Z'));
    expect(backup.fileName).toBe('capi-navigator-home-20261127T101500Z.tar.gz.gpg');
    expect(backup.summary).toMatch(/^17 objects, encrypted to [0-9A-F]{40}$/);
    // Ciphertext only: neither the archive nor a secret value can be found in it.
    const cipher = Buffer.from(backup.data);
    expect(cipher.includes(Buffer.from('KUBECONFIG'))).toBe(false);
    expect(() => gunzipSync(cipher)).toThrow();

    const tgz = await decrypt(backup.data, a.privateKey);
    const file = (name: string) => readFromChartArchive(tgz, (p) => p === name);
    const secrets = file('resources/10-secrets.yaml')!;
    for (const kept of ['management-cluster-aws-credentials', 'capi-navigator-session-key']) {
      expect(secrets).toContain(`name: ${kept}`);
    }
    expect(secrets).not.toContain('capi-navigator-initial-admin');
    expect(secrets).not.toContain('navigator-user-gone-password');
    const users = file('resources/16-navigatorusers.yaml')!;
    expect(users).not.toMatch(/uid|resourceVersion|namespace|status/);
    expect(file('resources/21-auditevents.yaml')).toBeUndefined();
    expect(JSON.parse(file('manifest.json')!)).toMatchObject({
      createdBy: 'admin',
      includesAuditEvents: false,
      namespace: 'capi-navigator-system',
    });
  });
});

/**
 * FP38-F-04 acceptance: the archive opens with the real gpg and tar, each recipient alone. Needs
 * gpg on the PATH; in CI it must be there.
 */
const hasGpg = (() => {
  try {
    execFileSync('gpg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGpg && !process.env.CI)('backup with GnuPG (FP38-F-04)', () => {
  it('decrypts with gpg -d for each recipient and unpacks with tar', async () => {
    const work = mkdtempSync(join(tmpdir(), 'backup-gpg-'));
    try {
      const homes = ['a', 'b'].map((n) => join(work, `gnupg-${n}`));
      const publicKeys: string[] = [];
      for (const home of homes) {
        execFileSync('mkdir', ['-m', '700', home]);
        const gpg = (...args: string[]) =>
          execFileSync(
            'gpg',
            [
              '--homedir',
              home,
              '--batch',
              '--pinentry-mode',
              'loopback',
              '--passphrase',
              '',
              ...args,
            ],
            {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            },
          );
        gpg(
          '--quick-gen-key',
          `Ops ${home.slice(-1)} <ops@example.com>`,
          'future-default',
          'default',
          'never',
        );
        publicKeys.push(gpg('--armor', '--export'));
      }
      const fake = backupStore();
      const svc = new BackupService(fake.store);
      await svc.updateSettings({
        recipients: publicKeys.map((publicKey) => ({ publicKey })),
        includeAuditEvents: true,
      });
      const backup = await svc.create('admin');
      const file = join(work, backup.fileName);
      writeFileSync(file, backup.data);
      for (const [i, home] of homes.entries()) {
        const out = join(work, `restore-${i}`);
        execFileSync('mkdir', [out]);
        execFileSync('sh', [
          '-c',
          `gpg --homedir "${home}" --batch --pinentry-mode loopback --passphrase '' -d "${file}" 2>/dev/null | tar xz -C "${out}"`,
        ]);
        expect(readdirSync(join(out, 'resources')).sort()).toContain('10-secrets.yaml');
        expect(readFileSync(join(out, 'resources', '10-secrets.yaml'), 'utf8')).toContain(
          'name: capi-navigator-oidc-client',
        );
        expect(readFileSync(join(out, 'RESTORE.md'), 'utf8')).toContain(
          'kubectl apply --server-side',
        );
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});
