import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * The storage suites talk to MinIO over HTTP, and they run concurrently with
     * the database-bound suites under `turbo run test`. 5s is a unit-test budget
     * and does not fit an integration one on a loaded machine.
     */
    testTimeout: 30_000,
  },
});
