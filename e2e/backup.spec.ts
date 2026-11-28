import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Backup of the home cluster (FP-38, part 1) and of the active management cluster (FP-39): add a
// key, download, decrypt with gpg. Needs an active admin account and gpg on the PATH:
//   E2E_ADMIN_PASSWORD=... pnpm test:e2e backup
const adminUser = process.env.E2E_ADMIN_USER ?? 'admin';
const adminPassword = process.env.E2E_ADMIN_PASSWORD;

async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test.describe('backup of the home cluster (FP-38)', () => {
  test.skip(!adminPassword, 'set E2E_ADMIN_PASSWORD to run');

  test('downloads a backup that gpg decrypts and tar lists', async ({ page }) => {
    const work = mkdtempSync(join(tmpdir(), 'e2e-backup-'));
    const home = join(work, 'gnupg');
    mkdirSync(home, { mode: 0o700 });
    const gpg = (...args: string[]) =>
      execFileSync(
        'gpg',
        ['--homedir', home, '--batch', '--pinentry-mode', 'loopback', '--passphrase', '', ...args],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
    try {
      gpg(
        '--quick-gen-key',
        'E2E Backup <e2e-backup@example.com>',
        'future-default',
        'default',
        '1d',
      );
      const publicKey = gpg('--armor', '--export');

      await signIn(page, adminUser, adminPassword!);
      await page.goto('/backup');
      await expect(page.getByTestId('backup-keys')).toBeVisible();
      const keysBefore = await page.getByTestId('backup-key-remove').count();

      await page.getByTestId('backup-key-input').locator('textarea').first().fill(publicKey);
      await page.getByTestId('backup-key-add').click();
      // Unsaved keys block the download.
      await expect(page.getByTestId('backup-download-button')).toBeDisabled();
      await page.getByTestId('backup-save').click();
      await expect(page.getByTestId('backup-changes')).toContainText('Key added');
      await page.getByTestId('backup-confirm').click();
      await expect(page.getByTestId('backup-key-list')).toContainText('e2e-backup@example.com');
      // A 1-day key is flagged (FP38-F-02).
      await expect(page.getByTestId('backup-key-expires-soon').first()).toBeVisible();
      await expect(page.getByTestId('backup-preview')).toContainText('NavigatorUser');

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByTestId('backup-download-button').click(),
      ]);
      expect(download.suggestedFilename()).toMatch(
        /^capi-navigator-home-\d{8}T\d{6}Z\.tar\.gz\.gpg$/,
      );
      const file = join(work, download.suggestedFilename());
      await download.saveAs(file);
      await expect(page.getByTestId('backup-downloaded')).toBeVisible();

      // Ciphertext on disk; gpg and tar open it.
      expect(readFileSync(file).includes(Buffer.from('kind: Secret'))).toBe(false);
      const listing = execFileSync('sh', [
        '-c',
        `gpg --homedir "${home}" --batch --pinentry-mode loopback --passphrase '' -d "${file}" 2>/dev/null | tar tz`,
      ]).toString();
      expect(listing).toContain('manifest.json');
      expect(listing).toContain('RESTORE.md');
      expect(listing).toMatch(/resources\/\d\d-navigatorusers\.yaml/);

      // FP-39: the backup of the active management cluster, restorable with clusterctl.
      await expect(page.getByTestId('backup-mgmt-capi')).toBeVisible({ timeout: 30_000 });
      const [mgmt] = await Promise.all([
        page.waitForEvent('download'),
        page.getByTestId('backup-mgmt-download').click(),
      ]);
      expect(mgmt.suggestedFilename()).toMatch(
        /^capi-navigator-mgmt-[a-z0-9-]+-\d{8}T\d{6}Z\.tar\.gz\.gpg$/,
      );
      const mgmtFile = join(work, mgmt.suggestedFilename());
      await mgmt.saveAs(mgmtFile);
      await expect(page.getByTestId('backup-mgmt-downloaded')).toBeVisible();
      const mgmtListing = execFileSync('sh', [
        '-c',
        `gpg --homedir "${home}" --batch --pinentry-mode loopback --passphrase '' -d "${mgmtFile}" 2>/dev/null | tar tz`,
      ]).toString();
      expect(mgmtListing).toContain('manifest.json');
      expect(mgmtListing).toContain('RESTORE.md');
      expect(mgmtListing).toMatch(/providers\/30-providers\.yaml/);

      // Leave the settings as they were.
      await page.getByTestId('backup-key-remove').nth(keysBefore).click();
      await page.getByTestId('backup-save').click();
      await expect(page.getByTestId('backup-changes')).toContainText('Key removed');
      await page.getByTestId('backup-confirm').click();
      await expect(page.getByTestId('backup-save')).toBeDisabled();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
