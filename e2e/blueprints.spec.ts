import { expect, test } from '@playwright/test';

// Cluster blueprints (FP-34, acceptance criterion "Playwright"). Needs an admin account and a
// cluster created by the app whose check passes (providers ready, credential tested and allowed):
//   E2E_ADMIN_PASSWORD=... E2E_BLUEPRINT_SOURCE=<connection>/<namespace>/<cluster> pnpm test:e2e
const adminUser = process.env.E2E_ADMIN_USER ?? 'admin';
const adminPassword = process.env.E2E_ADMIN_PASSWORD;
const source = process.env.E2E_BLUEPRINT_SOURCE;

test.describe('cluster blueprints (FP-34)', () => {
  test.skip(!adminPassword || !source, 'set E2E_ADMIN_PASSWORD and E2E_BLUEPRINT_SOURCE to run');

  test('an admin creates a blueprint from a cluster, checks, saves and deletes it', async ({
    page,
  }) => {
    const [connection, namespace, cluster] = source!.split('/') as [string, string, string];
    const name = `e2e-${Date.now().toString(36)}`;

    await page.goto('/login');
    await page.getByLabel('Username').fill(adminUser);
    await page.getByLabel('Password', { exact: true }).fill(adminPassword!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).not.toHaveURL(/\/login/);

    await page.goto('/blueprints');
    await expect(page.getByTestId('blueprints-table')).toBeVisible();
    await page.getByTestId('add-blueprint').click();
    await page.getByTestId('blueprint-name').getByRole('textbox').fill(name);
    await page.getByTestId('blueprint-display-name').getByRole('textbox').fill(`E2E ${name}`);
    await page.getByTestId('blueprint-connection').click();
    await page.getByRole('option', { name: connection, exact: true }).click();
    await page.getByTestId('blueprint-source').click();
    await page.getByRole('option', { name: `${namespace}/${cluster}`, exact: true }).click();

    // Number of workers of the first pool as parameter; the defaults fit the base spec.
    const counts = page.locator('[data-testid^="blueprint-count-"]');
    if ((await counts.count()) > 0) await counts.first().getByRole('checkbox').check();

    // FP34-F-04: saving only after a check without blockers, which shows the YAML.
    await expect(page.getByTestId('blueprint-save')).toBeDisabled();
    await page.getByTestId('blueprint-check').click();
    await expect(page.getByText('Generated YAML with the default parameters')).toBeVisible({
      timeout: 60_000,
    });
    await page.getByTestId('blueprint-save').click();
    await expect(page.getByTestId('blueprints-table')).toContainText(`E2E ${name}`);

    await page.getByTestId(`delete-blueprint-${name}`).click();
    await page.getByTestId('confirm-delete-blueprint').click();
    await expect(page.getByTestId('blueprints-table')).not.toContainText(`E2E ${name}`);
  });
});
