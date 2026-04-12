import path from 'node:path';
import { defineConfig } from 'prisma/config';

// Note: prisma.config.ts env() reads process.env directly (no .env auto-loading).
// The dev script and dotenv-cli handle .env loading before Prisma runs.
export default defineConfig({
  earlyAccess: true,
  schema: path.join(import.meta.dirname, 'schema.prisma'),
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
