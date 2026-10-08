import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The CLI acceptance test shells out to tsx; give it room on cold caches.
    testTimeout: 30_000,
    // `packaging.test.ts` packs and installs the real tarball in `beforeAll`,
    // which takes over a minute on a loaded Windows runner. That hook is
    // asynchronous so it does not block vitest's own RPC — which also means
    // vitest can now time it out, so the limit has to clear the slowest runner
    // rather than the fastest.
    hookTimeout: 300_000,
    // Fewer parallel workers on Windows: its CI runners have two cores, the
    // upgrade tests run many git processes, and with a worker per file
    // vitest's own main process starves and misses its RPC heartbeat
    // ("Timeout calling onTaskUpdate") though every test passes.
    ...(process.platform === 'win32' ? { maxWorkers: 2, minWorkers: 1 } : {}),
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
