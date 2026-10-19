import { expect, test, type Page } from '@playwright/test';

// API tokens of technical users (FP-22). Needs an active admin account:
//   E2E_ADMIN_PASSWORD=... pnpm test:e2e
const adminUser = process.env.E2E_ADMIN_USER ?? 'admin';
const adminPassword = process.env.E2E_ADMIN_PASSWORD;

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(adminUser);
  await page.getByLabel('Password', { exact: true }).fill(adminPassword!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test.describe('API tokens (FP-22)', () => {
  test.skip(!adminPassword, 'set E2E_ADMIN_PASSWORD to run');
  const created: string[] = [];

  // Also when the test fails half-way: remove the technical user, which removes its tokens.
  test.afterEach(async ({ playwright, baseURL }) => {
    const api = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { 'x-capi-navigator': '1' },
    });
    await api.post('/api/auth/login', { data: { username: adminUser, password: adminPassword } });
    for (const u of created.splice(0)) await api.delete(`/api/users/${u}`);
    await api.dispose();
  });

  test('an admin creates a technical user and a token that works on the API', async ({
    page,
    browser,
    request,
  }) => {
    const user = `e2e-ci-${Date.now().toString(36)}`;
    created.push(user);

    // Technical user (default assignment: viewer, everywhere) without password.
    await signIn(page);
    await page.goto('/users');
    await page.getByRole('button', { name: 'Add user' }).click();
    await page.getByLabel('Username').fill(user);
    await page.getByTestId('user-api-only').getByRole('checkbox').check();
    await expect(page.getByLabel('Initial password')).toHaveCount(0);
    await page.getByTestId('dialog-confirm').click();
    const row = page.getByRole('row', { name: new RegExp(user) });
    await expect(row).toContainText('technical');

    // Generate a token: shown once.
    await page.getByTestId(`tokens-${user}`).click();
    await page.getByTestId('token-name').getByRole('textbox').fill('pipeline');
    await page.getByTestId('token-generate').click();
    const token = (await page.getByTestId('token-value').textContent())!.trim();
    expect(token).toMatch(/^capin_/);
    await expect(page.getByTestId('tokens-table')).toContainText('pipeline');

    // The token works on the API without session and CSRF header, but cannot manage users.
    const auth = { Authorization: `Bearer ${token}` };
    const me = await request.get('/api/auth/me', { headers: auth });
    expect(me.status()).toBe(200);
    expect((await me.json()).username).toBe(user);
    expect((await request.get('/api/users', { headers: auth })).status()).toBe(403);

    // Swagger UI "Authorize" with the token, in a browser without session.
    const anonymous = await browser.newContext();
    const docs = await anonymous.newPage();
    await docs.goto('/api/docs/#/Auth/Auth_me');
    await docs.getByRole('button', { name: 'Authorize' }).first().click();
    const bearerForm = docs.locator('.auth-container form', {
      has: docs.locator('#auth-bearer-value'),
    });
    await bearerForm.locator('#auth-bearer-value').fill(token);
    await bearerForm.getByRole('button', { name: 'Apply credentials' }).click();
    await docs.locator('.modal-ux .close-modal').click();
    const op = docs.locator('#operations-Auth-Auth_me');
    await op.getByRole('button', { name: 'Try it out' }).click();
    await op.getByRole('button', { name: 'Execute' }).click();
    await expect(op.locator('.live-responses-table tbody .response-col_status').first()).toHaveText(
      '200',
    );
    await expect(op.locator('.live-responses-table tbody .microlight').first()).toContainText(user);
    await anonymous.close();

    // Revoke: the token stops working at once.
    await page.getByTestId('token-revoke-pipeline').click();
    await page.getByTestId('token-revoke-confirm').click();
    await expect(page.getByTestId('tokens-table')).not.toContainText('pipeline');
    expect((await request.get('/api/auth/me', { headers: auth })).status()).toBe(401);

    // Clean up.
    await page.keyboard.press('Escape');
    await row.getByRole('button', { name: 'Delete' }).click();
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('users-table')).not.toContainText(user);
  });
});
