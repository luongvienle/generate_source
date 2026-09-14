import { defineConfig } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: ['../../.env', '.env'] });

/**
 * P8a's commerce scenario buys through the FAKE payment provider, which is opt-in
 * and never a code default (an unset PAYMENT_PROVIDER closes checkout). Defaulted
 * here, after `.env`, so the suite does not depend on a developer's `.env`
 * holding the right values: the api web server below is a child process and
 * inherits these. An explicitly set PAYMENT_PROVIDER still wins.
 *
 * `e2e/helpers.ts` signs replayed and tampered webhooks with the same secret.
 */
process.env['PAYMENT_PROVIDER'] ??= 'fake';
process.env['PAYMENT_FAKE_WEBHOOK_SECRET'] ||= 'learner-e2e-only-fake-payment-secret';
process.env['API_PUBLIC_URL'] ||= 'http://localhost:3001';

/**
 * The learner browser suite.
 *
 * Kept out of `turbo run test` — the package script is `test:e2e`, not `test` —
 * so the unit and integration suites stay runnable without browsers installed,
 * exactly as admin-web's is.
 *
 * THREE web servers, because P7 is the first phase whose verification spans
 * both apps: the scenario authors and publishes a course through admin-web's
 * API, then reads it as a learner. The worker has no port to poll, so
 * globalSetup spawns it and waits on its log line.
 *
 * Serialized (`fullyParallel: false`, one worker) like admin-web's: these
 * suites share one database, and the api suites' own flakiness under concurrent
 * load is a solved problem only because nothing else runs beside them.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:3002',
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
      command:
        'pnpm --filter @knowledge-explorer/admin-web build && pnpm --filter @knowledge-explorer/admin-web start',
      cwd: '../..',
      url: 'http://localhost:3000/signin',
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command:
        'pnpm --filter @knowledge-explorer/learner-web build && pnpm --filter @knowledge-explorer/learner-web start',
      cwd: '../..',
      url: 'http://localhost:3002/signin',
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
