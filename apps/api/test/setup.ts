import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { beforeEach, afterAll } from 'vitest';

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE "RefreshToken", "WorkerCommand", "OutputSession", "StreamSession", "Output", "User" CASCADE
  `);
});

afterAll(async () => {
  await prisma.$disconnect();
});
