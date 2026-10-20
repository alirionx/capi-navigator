import { defineConfig, devices } from '@playwright/test';

// Screenshots for docs/ui-tour.md (`pnpm docs:screenshots`). Not a test suite: it only reads and
// needs the running app (`pnpm dev`) with workload clusters; see e2e/ui-tour.tour.ts.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.tour.ts',
  workers: 1,
  timeout: 5 * 60_000,
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:5173',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    actionTimeout: 30_000,
  },
  projects: [{ name: 'chromium' }],
});
