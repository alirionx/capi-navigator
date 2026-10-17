import { defineConfig, devices } from '@playwright/test';

// E2E tests (NF-17). Starts backend and frontend via `pnpm dev` unless BASE_URL is given.
const baseURL = process.env.BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.BASE_URL
    ? undefined
    : { command: 'pnpm dev', url: baseURL, reuseExistingServer: true, timeout: 120_000 },
});
