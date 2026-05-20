import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 10000,
    // Single fork pool because every test in this suite is fast and module-
    // level (vitest worker pools occasionally orphan when the suite is
    // interrupted, leaving zombie node processes). One fork keeps invariants
    // simple and the wall time stays under 2 seconds.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
