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
      await page.getByTestId('helm-repo-name').locator('input:not([type=hidden])').fill(repo);
      await page
        .getByTestId('helm-repo-url')
        .locator('input:not([type=hidden])')
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
      await page.getByTestId('new-helm-addon').click();
      await page.getByTestId('addon-name').locator('input:not([type=hidden])').fill(addon);
      await page.getByTestId('addon-namespace').locator('input:not([type=hidden])').fill(namespace);
      await page.getByTestId('addon-repository').click();
      await page.getByRole('option', { name: new RegExp(repo) }).click();
      await page.getByTestId('addon-chart').locator('input:not([type=hidden])').click();
      await page
        .getByRole('option', { name: /podinfo/ })
        .first()
        .click();
      await expect(
        page.getByTestId('addon-version').locator('input:not([type=hidden])'),
      ).not.toHaveValue('', {
        timeout: 30_000,
      });
      await page
        .getByTestId('selector-key-0')
        .locator('input:not([type=hidden])')
        .fill(`e2e/${suffix}`);
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
      await page
        .getByTestId('delete-addon-confirm')
        .locator('input:not([type=hidden])')
        .fill(addon);
      await page.getByTestId('delete-addon-apply').click();
      await expect(table).not.toContainText(addon, { timeout: 30_000 });
    } finally {
      await cleanup(request, repo, addon);
    }
  });
});

test.describe('Manifest add-ons (FP-30)', () => {
  test.skip(!adminPassword, 'set E2E_ADMIN_PASSWORD to run');

  // Needs the chart capi-navigator-manifests at the chart source of the connection (ghcr.io).
  test('example, object check, preview, apply and delete of a manifest add-on', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const addon = `e2e-manifests-${Date.now().toString(36)}`;
    try {
      await signIn(page, adminUser, adminPassword!);
      await page.goto('/addons');
      // FP30-F-03: the chart source and its version.
      await expect(page.getByTestId('manifest-chart-ok')).toBeVisible({ timeout: 30_000 });

      await page.getByTestId('new-addon').click();
      await page.getByTestId('new-manifest-addon').click();
      await page.getByTestId('manifest-addon-name').locator('input:not([type=hidden])').fill(addon);
      await page
        .getByTestId('manifest-addon-namespace')
        .locator('input:not([type=hidden])')
        .fill(namespace);
      await page
        .getByTestId('selector-key-0')
        .locator('input:not([type=hidden])')
        .fill(`e2e/${addon}`);
      // FP30-F-07: example with a CAAPH template; FP30-F-05: objects listed while typing.
      await page.getByText('Example: cert-manager ClusterIssuer').click();
      await page.getByTestId('use-example-cluster-issuer').click();
      await expect(page.getByTestId('manifest-addon-check')).toContainText(
        'ClusterIssuer letsencrypt',
      );
      await expect(page.getByTestId('addon-matching')).toContainText('none yet');

      // FP30-F-09: preview of the HelmChartProxy for the generic chart.
      await page.getByTestId('change-preview').click();
      const dialog = page.getByTestId('change-dialog');
      await expect(dialog).toContainText('capi-navigator-manifests', { timeout: 30_000 });
      await page.getByTestId('change-apply').click();

      const table = page.getByTestId('addons-table');
      await expect(table).toContainText(addon, { timeout: 30_000 });
      await expect(page.getByTestId(`addon-releases-${addon}`)).toHaveText('0/0');

      await page.getByTestId(`delete-addon-${addon}`).click();
      await page
        .getByTestId('delete-addon-confirm')
        .locator('input:not([type=hidden])')
        .fill(addon);
      await page.getByTestId('delete-addon-apply').click();
      await expect(table).not.toContainText(addon, { timeout: 30_000 });
    } finally {
      await request.post('/api/auth/login', {
        headers: CSRF,
        data: { username: adminUser, password: adminPassword },
      });
      await request.delete(`/api/connections/home/addons/${namespace}/${addon}`, { headers: CSRF });
    }
  });
});
