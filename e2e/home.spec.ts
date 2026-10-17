import { expect, test } from '@playwright/test';

test('backend health is OK (FP0-F-03)', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBe(true);
  expect((await res.json()).status).toBe('ok');
});

test('signed-out users land on the login page (FP-1)', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});
