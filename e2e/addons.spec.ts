import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Helm add-ons through the UI (FP-8) against the running app with CAAPH installed on the active
// connection (kind). Reads the public podinfo repository; the HelmChartProxy is created in the
// namespace given by E2E_ADDON_NAMESPACE (default capi-test) without matching clusters and removed
// again. Needs:
//   E2E_ADMIN_PASSWORD=... pnpm test:e2e
const adminUser = process.env.E2E_ADMIN_USER ?? 'admin';
const adminPassword = process.env.E2E_ADMIN_PASSWORD;
const namespace = process.env.E2E_ADDON_NAMESPACE ?? 'capi-test';
const CSRF = { 'x-capi-navigator': '1' };

async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function cleanup(request: APIRequestContext, repo: string, addon: string): Promise<void> {
  await request.post('/api/auth/login', {
    headers: CSRF,
    data: { username: adminUser, password: adminPassword },
  });
  await request.delete(`/api/connections/home/addons/${namespace}/${addon}`, { headers: CSRF });
  await request.delete(`/api/helm-repositories/${repo}`, { headers: CSRF });
}

test.describe('Helm add-ons (FP-8)', () => {
  test.skip(!adminPassword, 'set E2E_ADMIN_PASSWORD to run');

  test('repository, chart browser, preview, apply and delete of an add-on', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const suffix = Date.now().toString(36);
    const repo = `e2e-${suffix}`;
    const addon = `e2e-podinfo-${suffix}`;
    try {
      await signIn(page, adminUser, adminPassword!);

      // FP8-F-02: add and test an HTTP repository.
      await page.goto('/helm-repositories');
      await page.getByTestId('add-helm-repo').click();
      await page.getByTestId('helm-repo-name').locator('input').fill(repo);
      await page
        .getByTestId('helm-repo-url')
        .locator('input')
        .fill('https://stefanprodan.github.io/podinfo');
      await page.getByTestId('helm-repo-test').click();
      await expect(page.getByTestId('helm-repo-test-result')).toContainText('chart', {
        timeout: 30_000,
      });
      await page.getByTestId('helm-repo-save').click();
      await expect(page.getByTestId('helm-repos-table')).toContainText(repo);

      // FP8-F-04 to F-10: form with chart browser, defaults and preview.
      await page.goto('/addons');
      await page.getByTestId('new-addon').click();
      await page.getByTestId('addon-name').locator('input').fill(addon);
      await page.getByTestId('addon-namespace').locator('input').fill(namespace);
      await page.getByTestId('addon-repository').click();
      await page.getByRole('option', { name: new RegExp(repo) }).click();
      await page.getByTestId('addon-chart').locator('input').click();
      await page
        .getByRole('option', { name: /podinfo/ })
        .first()
        .click();
      await expect(page.getByTestId('addon-version').locator('input')).not.toHaveValue('', {
        timeout: 30_000,
      });
      await page.getByTestId('selector-key-0').locator('input').fill(`e2e/${suffix}`);
      await page.getByTestId('load-defaults').click();
      await expect(page.getByText(/Default values of podinfo/)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('addon-matching')).toContainText('none yet');
      await page.getByTestId('change-preview').click();
      await expect(page.getByTestId('change-dialog')).toContainText('HelmChartProxy', {
        timeout: 30_000,
      });
      await page.getByTestId('change-apply').click();

      const table = page.getByTestId('addons-table');
      await expect(table).toContainText(addon, { timeout: 30_000 });
      await expect(page.getByTestId(`addon-releases-${addon}`)).toHaveText('0/0');

      // FP8-F-13: delete with confirmation.
      await page.getByTestId(`delete-addon-${addon}`).click();
      await page.getByTestId('delete-addon-confirm').locator('input').fill(addon);
      await page.getByTestId('delete-addon-apply').click();
      await expect(table).not.toContainText(addon, { timeout: 30_000 });
    } finally {
      await cleanup(request, repo, addon);
    }
  });
});
