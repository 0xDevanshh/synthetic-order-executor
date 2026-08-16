import { defineConfig } from 'vitest/config';

/**
 * Integration suite: real Postgres, real Redis, real Sepolia.
 *
 * Separate from the default config so `pnpm test` stays infrastructure-free.
 * Longer timeouts because these make real database and network calls, and
 * serialised because the tests share real database state.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
