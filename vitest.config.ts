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
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
