import { expect, test, type Page } from '@playwright/test';

// FP-14: sign-in with OpenID Connect against Dex in kind. Needs `pnpm dev` and `pnpm dex:up`
// (which configures the app's sign-in with Dex); the test creates the group mappings itself:
//   E2E_OIDC=1 E2E_ADMIN_PASSWORD=... pnpm test:e2e e2e/oidc.spec.ts
const adminUser = process.env.E2E_ADMIN_USER ?? 'admin';
const adminPassword = process.env.E2E_ADMIN_PASSWORD;
const dexPassword = process.env.DEX_TEST_PASSWORD ?? 'Dex-Test-Password-1';
const CSRF = { 'x-capi-navigator': '1' };

async function signInWithDex(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('oidc-sign-in').click();
  // Dex login form (password connector).
  await page.locator('input[name="login"]').fill(email);
  await page.locator('input[name="password"]').fill(dexPassword);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/127\.0\.0\.1:5556/);
}

test.describe('sign-in with OpenID Connect (FP-14)', () => {
  test.skip(!process.env.E2E_OIDC || !adminPassword, 'set E2E_OIDC=1 and E2E_ADMIN_PASSWORD');
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ request }) => {
    await request.post('/api/auth/login', {
      headers: CSRF,
      data: { username: adminUser, password: adminPassword },
    });
    const existing = (await (await request.get('/api/oidc-groups')).json()) as { group: string }[];
    const want = [
      { group: 'capi-admins', bindings: [{ role: 'admin' }] },
      {
        group: 'team-a',
        bindings: [{ role: 'operator', connections: ['home'], namespaces: ['team-a'] }],
      },
    ];
    for (const m of want) {
      if (!existing.some((e) => e.group === m.group)) {
        expect((await request.post('/api/oidc-groups', { headers: CSRF, data: m })).ok()).toBe(
          true,
        );
      }
    }
  });

  test('a member of capi-admins signs in and manages users (FP14-F-04)', async ({ page }) => {
    await signInWithDex(page, 'alice@example.com');
    await expect(page.getByTestId('user-menu')).toContainText('(oidc)');
    await page.getByTestId('user-menu').click();
    await expect(page.getByTestId('oidc-info')).toContainText('capi-admins');
    await expect(page.getByText('Change password')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.goto('/users');
    await expect(page.getByTestId('oidc-groups-table')).toContainText('capi-admins');
  });

  test('a member of team-a gets the scoped operator role (FP14-F-04)', async ({ page }) => {
    await signInWithDex(page, 'bob@example.com');
    const me = await (await page.request.get('/api/auth/me')).json();
    expect(me).toMatchObject({
      source: 'oidc',
      groups: ['team-a'],
      bindings: [{ role: 'operator', connections: ['home'], namespaces: ['team-a'] }],
    });
    await page.goto('/users');
    await expect(page).not.toHaveURL(/\/users/);
  });

  test('a person without a mapped group gets the default role (FP14-F-05)', async ({ page }) => {
    await signInWithDex(page, 'carol@example.com');
    const me = await (await page.request.get('/api/auth/me')).json();
    expect(me.bindings).toMatchObject([{ role: 'viewer' }]);
    await page.getByTestId('user-menu').click();
    await page.getByTestId('sign-out').click();
    await expect(page).toHaveURL(/\/login|127\.0\.0\.1:5556/);
  });

  test('admins set up the provider on the Authentication page (FP14-F-12)', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Username').fill(adminUser);
    await page.getByLabel('Password', { exact: true }).fill(adminPassword!);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL(/\/login/);

    await page.goto('/authentication');
    await expect(page.getByTestId('redirect-uri')).toContainText('/api/auth/oidc/callback');
    await page.getByTestId('oidc-test').click();
    await expect(page.getByTestId('oidc-test-result')).toContainText('Provider found');

    const label = page.getByLabel('Button label');
    const save = async () => {
      await page.getByTestId('oidc-preview').click();
      await expect(page.getByTestId('oidc-confirm')).toBeVisible();
      await page.getByTestId('oidc-save').click();
      await expect(page.getByTestId('oidc-saved')).toBeVisible();
    };
    await label.fill('Sign in with Company SSO');
    await save();
    const options = async () => (await (await page.request.get('/api/auth/options')).json()).oidc;
    expect(await options()).toEqual({ label: 'Sign in with Company SSO' });

    // Off: the button disappears; on again with the original label.
    await page.getByTestId('oidc-enabled').locator('input').click();
    await save();
    expect(await options()).toBeNull();
    await page.getByTestId('oidc-enabled').locator('input').click();
    await label.fill('Sign in with Dex');
    await save();
    expect(await options()).toEqual({ label: 'Sign in with Dex' });
  });

  test('the local sign-in keeps working (FP14-F-07)', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Username').fill(adminUser);
    await page.getByLabel('Password', { exact: true }).fill(adminPassword!);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL(/\/login/);
  });
});
