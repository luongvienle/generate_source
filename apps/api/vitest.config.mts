import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The default glob is *.spec.ts, which silently skips NestJS's
    // *.e2e-spec.ts convention — a skipped file is indistinguishable from a
    // passing one in the summary output, so both spellings are listed.
    include: ['test/**/*.spec.ts', 'test/**/*-spec.ts'],
    // These suites share one database and mutate rows; run files in sequence.
    fileParallelism: false,
  },
});
