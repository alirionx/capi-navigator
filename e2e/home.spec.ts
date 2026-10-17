import { expect, test } from '@playwright/test';

test('start page shows "Backend: OK" (FP0-F-03)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('backend-status')).toContainText('Backend: OK');
});
