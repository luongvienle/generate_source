import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * `isGrantActive` is pure, but the two resolvers cross Postgres, and this
     * suite runs concurrently with the other database-bound suites under
     * `turbo run test`. 5s is a unit-test budget; mirrors apps/api and
     * packages/storage.
     */
    testTimeout: 30_000,
    /** Shares one database with the api suites; do not run files in parallel. */
    fileParallelism: false,
  },
});
