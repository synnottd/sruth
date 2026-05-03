import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // DB-backed integration suites share the same test database and TRUNCATE
    // between tests; running files in parallel would race those truncations.
    fileParallelism: false,
    env: {
      // Shared by DB-backed integration tests. Matches the API test convention
      // (see apps/api/vitest.config.ts) so both suites target the same dedicated
      // test database.
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://sruth:sruth@localhost:5432/sruth_test',
    },
  },
});
