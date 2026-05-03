import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { WorkerCommand } from '@sruth/shared';
import { sweep } from '../src/orphan-reaper.js';

/**
 * Integration tests for the orphan reaper against a real Postgres.
 *
 * The reaper flips CLAIMED rows whose `claimedAt` is older than the stale
 * window to FAILED with a canned lastError, so a worker crash mid-handler
 * doesn't strand rows as CLAIMED forever.
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

function cmd(sessionId: string): Prisma.InputJsonValue {
  const value: WorkerCommand = { type: 'stop', userId: 'u1', sessionId };
  return value as unknown as Prisma.InputJsonValue;
}

describe('orphan-reaper integration (real Postgres)', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      throw new Error(
        `Cannot reach test database at ${process.env.DATABASE_URL}.\n\n` +
          `Original error: ${(err as Error).message}`,
      );
    }
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "WorkerCommand"');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('sweep flips stale CLAIMED rows to FAILED with orphaned lastError', async () => {
    const sixMinAgo = new Date(Date.now() - 6 * 60_000);
    await prisma.workerCommand.create({
      data: {
        id: 'c-stale',
        payload: cmd('s-stale'),
        status: 'CLAIMED',
        claimedAt: sixMinAgo,
      },
    });

    await sweep(prisma, { staleAfterMs: 5 * 60_000 });

    const row = await prisma.workerCommand.findUnique({ where: { id: 'c-stale' } });
    expect(row?.status).toBe('FAILED');
    expect(row?.lastError).toBe('orphaned: worker crash');
    expect(row?.completedAt).toBeInstanceOf(Date);
  });

  it('sweep leaves fresh CLAIMED rows untouched', async () => {
    const oneMinAgo = new Date(Date.now() - 60_000);
    await prisma.workerCommand.create({
      data: {
        id: 'c-fresh',
        payload: cmd('s-fresh'),
        status: 'CLAIMED',
        claimedAt: oneMinAgo,
      },
    });

    await sweep(prisma, { staleAfterMs: 5 * 60_000 });

    const row = await prisma.workerCommand.findUnique({ where: { id: 'c-fresh' } });
    expect(row?.status).toBe('CLAIMED');
    expect(row?.lastError).toBeNull();
    expect(row?.completedAt).toBeNull();
  });

  it('sweep does not touch PENDING rows even if they are old', async () => {
    // Reaper must use claimedAt (not createdAt); a row can sit PENDING for
    // hours before being claimed without being an orphan.
    const tenMinAgo = new Date(Date.now() - 10 * 60_000);
    await prisma.workerCommand.create({
      data: {
        id: 'c-old-pending',
        payload: cmd('s-old-pending'),
        status: 'PENDING',
        createdAt: tenMinAgo,
      },
    });

    await sweep(prisma, { staleAfterMs: 5 * 60_000 });

    const row = await prisma.workerCommand.findUnique({
      where: { id: 'c-old-pending' },
    });
    expect(row?.status).toBe('PENDING');
  });
});
