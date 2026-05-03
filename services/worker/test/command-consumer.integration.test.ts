import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { WorkerCommand } from '@sruth/shared';
import { CommandConsumer } from '../src/command-consumer.js';

/**
 * Integration tests for CommandConsumer against a real Postgres.
 *
 * Covers the UPDATE-on-claim queue model: PENDING → CLAIMED → DONE/FAILED.
 * DONE/FAILED rows are preserved (not deleted) so operators can grep queue
 * state and the orphan reaper can find stale CLAIMED rows.
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

function invokeProcessNext(
  consumer: CommandConsumer,
  handler: (c: WorkerCommand) => Promise<void>,
): Promise<void> {
  return (
    consumer as unknown as {
      processNext: (h: typeof handler) => Promise<void>;
    }
  ).processNext(handler);
}

function cmd(sessionId: string): Prisma.InputJsonValue {
  const value: WorkerCommand = { type: 'stop', userId: 'u1', sessionId };
  return value as unknown as Prisma.InputJsonValue;
}

describe('CommandConsumer integration (real Postgres)', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      throw new Error(
        `Cannot reach test database at ${process.env.DATABASE_URL}. ` +
          `Start Postgres (docker compose up -d postgres) and ensure the ` +
          `test database exists with the Prisma schema pushed.\n\n` +
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

  it('claim transitions PENDING -> CLAIMED with claimedAt set', async () => {
    await prisma.workerCommand.create({ data: { id: 'c-1', payload: cmd('s-1') } });

    const consumer = new CommandConsumer(prisma, 10);
    let midHandler: { status: string; claimedAt: Date | null } | null = null;
    await invokeProcessNext(consumer, async () => {
      const row = await prisma.workerCommand.findUnique({ where: { id: 'c-1' } });
      midHandler = row ? { status: row.status, claimedAt: row.claimedAt } : null;
    });

    expect(midHandler).not.toBeNull();
    expect(midHandler!.status).toBe('CLAIMED');
    expect(midHandler!.claimedAt).toBeInstanceOf(Date);
  });

  it('successful handler marks the row DONE with completedAt', async () => {
    await prisma.workerCommand.create({ data: { id: 'c-1', payload: cmd('s-1') } });

    const consumer = new CommandConsumer(prisma, 10);
    await invokeProcessNext(consumer, async () => {
      /* success */
    });

    const row = await prisma.workerCommand.findUnique({ where: { id: 'c-1' } });
    expect(row?.status).toBe('DONE');
    expect(row?.completedAt).toBeInstanceOf(Date);
    expect(row?.lastError).toBeNull();
  });

  it('completion is a no-op when row was flipped out of CLAIMED mid-handler', async () => {
    // Regression guard for reaper/handler race: if the reaper decides the
    // claim is stale and flips the row to FAILED while the handler is still
    // running, a late-arriving handler completion must not overwrite that.
    await prisma.workerCommand.create({ data: { id: 'c-1', payload: cmd('s-1') } });

    const consumer = new CommandConsumer(prisma, 10);
    await invokeProcessNext(consumer, async () => {
      // Simulate reaper flipping the row while the handler is mid-flight.
      await prisma.workerCommand.update({
        where: { id: 'c-1' },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          lastError: 'orphaned: worker crash',
        },
      });
    });

    const row = await prisma.workerCommand.findUnique({ where: { id: 'c-1' } });
    expect(row?.status).toBe('FAILED');
    expect(row?.lastError).toBe('orphaned: worker crash');
  });

  it('throwing handler marks the row FAILED with lastError', async () => {
    await prisma.workerCommand.create({ data: { id: 'c-1', payload: cmd('s-1') } });

    const consumer = new CommandConsumer(prisma, 10);
    // Silence the expected error log so test output stays clean.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await invokeProcessNext(consumer, async () => {
      throw new Error('simulated handler failure');
    });
    errSpy.mockRestore();

    const row = await prisma.workerCommand.findUnique({ where: { id: 'c-1' } });
    expect(row?.status).toBe('FAILED');
    expect(row?.completedAt).toBeInstanceOf(Date);
    expect(row?.lastError).toBe('simulated handler failure');
  });

  it('claims commands in FIFO order by createdAt and skips non-PENDING rows', async () => {
    const now = Date.now();
    await prisma.workerCommand.createMany({
      data: [
        { id: 'c-1', payload: cmd('s-first'), createdAt: new Date(now - 3000) },
        { id: 'c-2', payload: cmd('s-second'), createdAt: new Date(now - 2000) },
        { id: 'c-3', payload: cmd('s-third'), createdAt: new Date(now - 1000) },
      ],
    });

    const seen: string[] = [];
    const consumer = new CommandConsumer(prisma, 10);
    const handler = async (c: WorkerCommand) => {
      seen.push(c.sessionId);
    };

    await invokeProcessNext(consumer, handler);
    await invokeProcessNext(consumer, handler);
    await invokeProcessNext(consumer, handler);
    await invokeProcessNext(consumer, handler); // queue drained — no more PENDING

    expect(seen).toEqual(['s-first', 's-second', 's-third']);
    // All claimed rows were settled to DONE, not deleted.
    const statuses = await prisma.workerCommand.findMany({
      orderBy: { createdAt: 'asc' },
      select: { status: true },
    });
    expect(statuses.map((r) => r.status)).toEqual(['DONE', 'DONE', 'DONE']);
  });

  it('two concurrent claims pick different rows (FOR UPDATE SKIP LOCKED)', async () => {
    const now = Date.now();
    await prisma.workerCommand.createMany({
      data: [
        { id: 'c-a', payload: cmd('s-a'), createdAt: new Date(now - 2000) },
        { id: 'c-b', payload: cmd('s-b'), createdAt: new Date(now - 1000) },
      ],
    });

    const seen: string[] = [];
    const consumer = new CommandConsumer(prisma, 10);
    const handler = async (c: WorkerCommand) => {
      seen.push(c.sessionId);
    };

    await Promise.all([
      invokeProcessNext(consumer, handler),
      invokeProcessNext(consumer, handler),
    ]);

    expect(seen.sort()).toEqual(['s-a', 's-b']);
  });
});
