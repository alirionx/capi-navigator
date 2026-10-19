import { expect, test } from '@playwright/test';

// Swagger UI (FP-23). Needs an active admin account: E2E_ADMIN_PASSWORD=... pnpm test:e2e
const adminUser = process.env.E2E_ADMIN_USER ?? 'admin';
const adminPassword = process.env.E2E_ADMIN_PASSWORD;

test.describe('API documentation (FP-23)', () => {
  test.skip(!adminPassword, 'set E2E_ADMIN_PASSWORD to run');

  test('Swagger UI runs requests with the session and the CSRF header', async ({ page }) => {
    const blocked: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text()))
        blocked.push(m.text());
    });

    await page.goto('/login');
    await page.getByLabel('Username').fill(adminUser);
    await page.getByLabel('Password', { exact: true }).fill(adminPassword!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).not.toHaveURL(/\/login/);

    // Deep links open the operation directly.
    await page.goto('/api/docs/#/Auth/Auth_me');
    await expect(page.getByRole('heading', { name: /CAPI Navigator API/ })).toBeVisible();

    // GET with the session cookie.
    const me = page.locator('#operations-Auth-Auth_me');
    await me.getByRole('button', { name: 'Try it out' }).click();
    await me.getByRole('button', { name: 'Execute' }).click();
    await expect(me.locator('.live-responses-table tbody .response-col_status').first()).toHaveText(
      '200',
    );
    await expect(me.locator('.live-responses-table tbody .microlight').first()).toContainText(
      `"username": "${adminUser}"`,
    );

    // POST: the start script adds the CSRF header, so the request reaches the validation (400),
    // not the CSRF check (403).
    await page.goto('/api/docs/#/Connections/Connections_contexts');
    await page.reload();
    const contexts = page.locator('#operations-Connections-Connections_contexts');
    await contexts.getByRole('button', { name: 'Try it out' }).click();
    await contexts.getByRole('button', { name: 'Execute' }).click();
    const body = contexts.locator('.live-responses-table tbody .microlight').first();
    await expect(body).toBeVisible();
    await expect(body).not.toContainText('CSRF');
    await expect(
      contexts.locator('.live-responses-table tbody .response-col_status').first(),
    ).toHaveText('400');

    expect(blocked).toEqual([]);
  });
});
