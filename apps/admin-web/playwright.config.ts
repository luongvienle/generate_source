import { defineConfig } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * The browser end-to-end suite.
 *
 * Kept out of `turbo run test` — the package script is `test:e2e`, not `test` —
 * so the unit and integration suites stay runnable without browsers installed.
 *
 * Playwright owns the API and admin-web processes through `webServer`. The
 * worker has no port to poll, so globalSetup spawns it instead.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @knowledge-explorer/api start',
      cwd: '../..',
      url: 'http://localhost:3001/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @knowledge-explorer/admin-web build && pnpm --filter @knowledge-explorer/admin-web start',
      cwd: '../..',
      url: 'http://localhost:3000/signin',
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
