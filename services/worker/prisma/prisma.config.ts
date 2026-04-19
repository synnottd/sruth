import path from 'node:path';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  earlyAccess: true,
  schema: path.join(import.meta.dirname, '../../../packages/shared/prisma/schema.prisma'),
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
