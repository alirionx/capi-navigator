import { expect, test } from '@playwright/test';

// Connections flow (FP-2). Needs an active admin account: E2E_ADMIN_PASSWORD=... pnpm test:e2e
const adminPassword = process.env.E2E_ADMIN_PASSWORD;

test.describe('management cluster connections (FP-2)', () => {
  test.skip(!adminPassword, 'set E2E_ADMIN_PASSWORD to run');

  test('rejects an exec-based kubeconfig with an understandable message', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Username').fill(process.env.E2E_ADMIN_USER ?? 'admin');
    await page.getByLabel('Password', { exact: true }).fill(adminPassword!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).not.toHaveURL(/\/login/);

    await page.goto('/connections');
    await page.getByTestId('add-connection').click();
    await page.getByLabel('Name', { exact: true }).fill(`e2e-${Date.now().toString(36)}`);
    await page.getByLabel('Kubeconfig', { exact: true }).fill(`
apiVersion: v1
kind: Config
current-context: eks
clusters: [{ name: eks, cluster: { server: 'https://eks.example:443' } }]
users: [{ name: eks, user: { exec: { command: aws, args: [eks, get-token] } } }]
contexts: [{ name: eks, context: { cluster: eks, user: eks } }]
`);
    await page.getByLabel('Context').waitFor();
    await page.getByTestId('connection-save').click();
    await expect(page.getByTestId('error-alert')).toContainText('exec plugin');
  });
});
