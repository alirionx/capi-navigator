import { expect, test, type Page } from '@playwright/test';

// Custom roles (FP-19, acceptance criterion "custom role"). Needs an active admin account:
//   E2E_ADMIN_PASSWORD=... pnpm test:e2e
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

test.describe('custom roles (FP-19)', () => {
  test.skip(!adminPassword, 'set E2E_ADMIN_PASSWORD to run');

  test('a day-2 role can open clusters but not create them or manage users', async ({ page }) => {
    const id = Date.now().toString(36);
    const role = `e2e-day2-${id}`;
    const roleTitle = `E2E day-2 ${id}`;
    const user = `e2e-d2-${id}`;

    // Admin: create the role with clusters.change only.
    await signIn(page, adminUser, adminPassword!);
    await page.goto('/roles');
    await expect(page.getByTestId('roles-table')).toContainText('built-in');
    await page.getByTestId('role-add').click();
    await page.getByTestId('role-name').getByRole('textbox').fill(role);
    await page.getByTestId('role-display-name').getByRole('textbox').fill(roleTitle);
    await page.getByTestId('permission-clusters.change').getByRole('checkbox').check();
    await page.getByTestId('role-confirm').click();
    await expect(page.getByTestId('roles-table')).toContainText(roleTitle);

    // Admin: create a user with this role as the only assignment.
    await page.goto('/users');
    await page.getByRole('button', { name: 'Add user' }).click();
    await page.getByLabel('Username').fill(user);
    await page.getByTestId('binding-0-role').click();
    await page.getByRole('option', { name: roleTitle }).click();
    await page.getByLabel('Initial password').fill('E2e-Temp-Password-1');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('users-table')).toContainText(`${roleTitle} · everywhere`);
    await signOut(page);

    // User: no create button, no admin pages; direct navigation is redirected.
    await signIn(page, user, 'E2e-Temp-Password-1');
    await page.getByLabel('Current password').fill('E2e-Temp-Password-1');
    await page.getByLabel('New password', { exact: true }).fill('E2e-New-Password-1');
    await page.getByLabel('Repeat new password').fill('E2e-New-Password-1');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Roles' })).toHaveCount(0);
    await page.goto('/clusters');
    await expect(page.getByTestId('clusters-table')).toBeVisible();
    await expect(page.getByTestId('new-cluster')).toHaveCount(0);
    await page.goto('/roles');
    await expect(page).toHaveURL(/\/$/);
    await signOut(page);

    // Clean up: the role can only be deleted once nobody has it.
    await signIn(page, adminUser, adminPassword!);
    await page.goto('/users');
    await page
      .getByRole('row', { name: new RegExp(user) })
      .getByRole('button', { name: 'Delete' })
      .click();
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('users-table')).not.toContainText(user);
    await page.goto('/roles');
    await page.getByTestId(`role-delete-${role}`).click();
    await page.getByTestId('role-confirm').click();
    await expect(page.getByTestId('roles-table')).not.toContainText(roleTitle);
  });
});
