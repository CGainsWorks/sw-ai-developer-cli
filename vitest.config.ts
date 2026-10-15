import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Windows CI is noticeably slower at spawning `git`; give the repo
    // integration tests room rather than flaking the matrix.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      // Nothing is excluded. The only untested file would be the process
      // wrapper, and that lives in bin/swai.js precisely so `src/` can stay
      // fully exercisable in-process.
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 85,
        branches: 80,
      },
    },
  },
});
