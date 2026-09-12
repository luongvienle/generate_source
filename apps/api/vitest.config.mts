import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The default glob is *.spec.ts, which silently skips NestJS's
    // *.e2e-spec.ts convention — a skipped file is indistinguishable from a
    // passing one in the summary output, so both spellings are listed.
    include: ['test/**/*.spec.ts', 'test/**/*-spec.ts'],
    // These suites share one database and mutate rows; run files in sequence.
    fileParallelism: false,
    /**
     * These are integration tests: every assertion crosses HTTP, Postgres and —
     * since P3 — MinIO. vitest's 5s default left no headroom once `turbo run
     * test` began running object-storage suites concurrently with this one, and
     * the symptom was P2 tests timing out rather than anything failing. The
     * suites are deterministic in isolation and when turbo is serialized; the
     * budget was simply too tight for the machine, not for the code.
     */
    testTimeout: 30_000,
  },
});
