import { expect, test, type Page } from '@playwright/test';

// FP-14: sign-in with OpenID Connect against Dex in kind. Needs `pnpm dex:up`, then `pnpm dev`
// (restarted, so it reads the Dex settings), and the group mappings this test creates:
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

  test('the local sign-in keeps working (FP14-F-07)', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Username').fill(adminUser);
    await page.getByLabel('Password', { exact: true }).fill(adminPassword!);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL(/\/login/);
  });
});
