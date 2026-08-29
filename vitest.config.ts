import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 10000,
    // Single fork because every test in this suite is fast and module-level
    // (vitest worker pools occasionally orphan when the suite is interrupted,
    // leaving zombie node processes). One fork keeps invariants simple and the
    // wall time stays under 2 seconds.
    //
    // Vitest 4 removed poolOptions; this pair replaces forks.singleFork. Both
    // keys are load-bearing: maxWorkers caps concurrency but isolate defaults
    // to true, which still forks a fresh process per test file. Measured on
    // four probe files: singleFork on v2 = 1 pid, maxWorkers alone on v4 = 4
    // pids, this pair on v4 = 1 pid.
    pool: 'forks',
    maxWorkers: 1,
    isolate: false,
  },
});
