import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import Redis from 'ioredis';
import { beforeEach, afterAll } from 'vitest';

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE "OutputSession", "StreamSession", "Output", "User" CASCADE
  `);
  await redis.flushdb();
});

afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});
