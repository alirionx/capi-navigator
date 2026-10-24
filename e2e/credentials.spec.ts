import { expect, test } from '@playwright/test';

// FP-4 through the UI (read-only against the real cloud). Needs the OpenStack provider installed
// on the active connection and:
//   E2E_ADMIN_PASSWORD=... OPENSTACK_CLOUDS_YAML=~/.config/openstack/clouds.yaml pnpm test:e2e
const adminPassword = process.env.E2E_ADMIN_PASSWORD;
const cloudsYaml = process.env.OPENSTACK_CLOUDS_YAML;
const connection = process.env.E2E_CONNECTION ?? 'home';

test('OpenStack credentials: upload clouds.yaml, preview, test, selection list, delete', async ({
  page,
}) => {
  test.skip(
    !adminPassword || !cloudsYaml,
    'set E2E_ADMIN_PASSWORD and OPENSTACK_CLOUDS_YAML to run',
  );
  test.setTimeout(120_000);
  const name = `e2e-${Date.now().toString(36)}`;
  await page.goto('/login');
  await page.getByLabel('Username').fill(process.env.E2E_ADMIN_USER ?? 'admin');
  await page.getByLabel('Password', { exact: true }).fill(adminPassword!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.evaluate(
    (c) => localStorage.setItem('capi-navigator.activeConnection', c),
    connection,
  );
  await page.goto('/credentials');

  await page.getByTestId('add-credential').click();
  await page.getByTestId('add-openstack').click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.locator('input[type=file]').first().setInputFiles(cloudsYaml!);
  await expect(page.getByLabel('Cloud', { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('credential-next').click();
  // Monaco renders only visible lines: check the masked Secret at the top.
  await expect(page.locator('.monaco-editor')).toContainText('clouds.yaml: "********"', {
    timeout: 20_000,
  });
  await expect(page.locator('.monaco-editor')).not.toContainText('application_credential_secret');
  await page.getByTestId('credential-save').click();

  const table = page.getByTestId('credentials-table');
  await expect(table).toContainText(name);
  await expect(table).toContainText('OK', { timeout: 30_000 });
  await page.getByTestId(`lookup-kind-${name}`).click();
  await page.getByRole('option', { name: 'Flavors' }).click();
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByTestId(`lookup-result-${name}`)).toContainText('entries', {
    timeout: 20_000,
  });

  await table
    .getByRole('row', { name: new RegExp(name) })
    .first()
    .getByRole('button', { name: 'Delete' })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(table).not.toContainText(name, { timeout: 15_000 });
});
