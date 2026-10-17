import { expect, test, type Page } from '@playwright/test';

// FP-3 acceptance through the UI against the local kind cluster (`pnpm kind:up`).
// Needs an admin account and a connection to kind:
//   E2E_ADMIN_PASSWORD=... E2E_CONNECTION=home pnpm test:e2e e2e/providers.spec.ts
// Installs ORC and providers for real and removes them again afterwards.
const adminPassword = process.env.E2E_ADMIN_PASSWORD;
const connection = process.env.E2E_CONNECTION ?? 'home';
const MIN = 60_000;

test.describe.configure({ mode: 'serial' });

test.describe('providers via the UI (FP-3)', () => {
  test.skip(!adminPassword, 'set E2E_ADMIN_PASSWORD to run');
  test.setTimeout(30 * MIN);

  async function signIn(page: Page): Promise<void> {
    await page.goto('/login');
    await page.getByLabel('Username').fill(process.env.E2E_ADMIN_USER ?? 'admin');
    await page.getByLabel('Password', { exact: true }).fill(adminPassword!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).not.toHaveURL(/\/login/);
    await page.evaluate(
      (c) => localStorage.setItem('capi-navigator.activeConnection', c),
      connection,
    );
    await page.goto('/providers');
    await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 30_000 });
  }

  async function install(page: Page, id: string, version?: string): Promise<void> {
    await page.getByTestId(`install-${id}`).click();
    if (version) await page.getByLabel('Version').fill(version);
    await page.getByTestId('provider-preview').click();
    await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('provider-apply').click();
    await expect(page.getByTestId('provider-apply')).toBeHidden();
  }

  async function waitReady(page: Page, id: string, timeout = 8 * MIN): Promise<void> {
    await expect(page.getByTestId(`catalog-${id}`).getByText('Ready', { exact: true })).toBeVisible(
      {
        timeout,
      },
    );
  }

  test('installs ORC, core, RKE2, OpenStack, CAAPH and AWS; all become Ready', async ({ page }) => {
    await signIn(page);
    await expect(page.getByTestId('prerequisites')).toContainText('cert-manager');
    await expect(page.getByTestId('install-openstack')).toBeDisabled();

    await page.getByTestId('orc-install').click();
    await page.getByTestId('orc-preview').click();
    await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('orc-apply').click();
    await expect(page.getByTestId('prerequisites')).toContainText('v2.6.0', { timeout: 5 * MIN });

    await install(page, 'core');
    await waitReady(page, 'core');

    await install(page, 'rke2-bootstrap');
    await install(page, 'rke2-control-plane');
    await install(page, 'openstack');
    await install(page, 'helm', 'v0.6.2');
    await install(page, 'aws');
    for (const id of ['rke2-bootstrap', 'rke2-control-plane', 'openstack', 'helm', 'aws']) {
      await waitReady(page, id);
    }
    await expect(page.getByTestId('providers-table')).not.toContainText('Failed');
  });

  test('upgrades CAAPH via the UI', async ({ page }) => {
    await signIn(page);
    const row = page.getByTestId('providers-table').getByRole('row', { name: /Helm add-ons/ });
    await row.getByRole('button', { name: 'Upgrade / configure' }).click();
    await page.getByLabel('Version').fill('v0.6.4');
    await page.getByTestId('provider-preview').click();
    await expect(page.locator('.monaco-editor')).toContainText('v0.6.4');
    await page.getByTestId('provider-apply').click();
    await expect(row).toContainText('v0.6.4', { timeout: 6 * MIN });
    await expect(row).toContainText('Ready', { timeout: 6 * MIN });
  });

  test('removes the providers again', async ({ page }) => {
    await signIn(page);
    const order = [
      'Helm add-ons',
      'AWS',
      'OpenStack',
      'RKE2 control plane',
      'RKE2 bootstrap',
      'Cluster API',
    ];
    for (const name of order) {
      const row = page.getByTestId('providers-table').getByRole('row', { name: new RegExp(name) });
      await row.getByRole('button', { name: 'Remove' }).click();
      const crName = (await row.locator('.text-caption').first().textContent())!.trim();
      await page.getByTestId('remove-confirm').locator('input').fill(crName);
      await page.getByTestId('remove-apply').click();
      await expect(page.getByTestId('remove-apply')).toBeHidden();
      await expect(row).toHaveCount(0, { timeout: 4 * MIN });
    }
  });
});
