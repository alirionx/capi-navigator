import { expect, test, type Page } from '@playwright/test';

// Login flow (NF-17). Needs an active admin account of the running app:
//   E2E_ADMIN_PASSWORD=... pnpm test:e2e   (user defaults to "admin")
const adminUser = process.env.E2E_ADMIN_USER ?? 'admin';
const adminPassword = process.env.E2E_ADMIN_PASSWORD;

async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function signOut(page: Page): Promise<void> {
  await page.getByTestId('user-menu').click();
  await page.getByTestId('sign-out').click();
  await expect(page).toHaveURL(/\/login/);
}

test.describe('authentication and roles (FP-1)', () => {
  test.skip(!adminPassword, 'set E2E_ADMIN_PASSWORD to run');

  test('admin creates a viewer who must change the password and sees no admin pages', async ({
    page,
  }) => {
    const viewer = `e2e-${Date.now().toString(36)}`;

    await signIn(page, adminUser, adminPassword!);
    await page.goto('/users');
    await page.getByRole('button', { name: 'Add user' }).click();
    await page.getByLabel('Username').fill(viewer);
    await page.getByLabel('Initial password').fill('E2e-Temp-Password-1');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('users-table')).toContainText(viewer);
    await signOut(page);

    await signIn(page, viewer, 'E2e-Temp-Password-1');
    await expect(page).toHaveURL(/\/change-password/);
    await page.getByLabel('Current password').fill('E2e-Temp-Password-1');
    await page.getByLabel('New password', { exact: true }).fill('E2e-New-Password-1');
    await page.getByLabel('Repeat new password').fill('E2e-New-Password-1');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0);
    await page.goto('/users');
    await expect(page).toHaveURL(/\/$/);
    await signOut(page);

    // Clean up.
    await signIn(page, adminUser, adminPassword!);
    await page.goto('/users');
    await page
      .getByRole('row', { name: new RegExp(viewer) })
      .getByRole('button', { name: 'Delete' })
      .click();
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('users-table')).not.toContainText(viewer);
  });
});
