import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      DATABASE_URL: 'postgresql://omega:omega@localhost:5432/omega_stream_test',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'test-secret',
      JWT_ACCESS_EXPIRY: '15m',
      JWT_REFRESH_EXPIRY: '7d',
      AUTH_RATE_LIMIT_MAX: '1000',
    },
    setupFiles: ['./test/setup.ts'],
    sequence: { concurrent: false },
    fileParallelism: false,
  },
});
