import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { WorkerCommand } from '@sruth/shared';
import { CommandConsumer } from '../src/command-consumer.js';

/**
 * Integration tests for CommandConsumer against a real Postgres.
 *
 * These cover what the unit tests can't: the SQL itself (syntax, column
 * quoting), real FIFO ordering by `createdAt`, Postgres row-locking semantics
 * (`FOR UPDATE SKIP LOCKED`), and concurrent-claim behaviour via Prisma's
 * connection pool.
 *
 * Prereqs:
 *   - Postgres running (project-root `docker-compose.yml`).
 *   - `sruth_test` database exists with the Prisma schema pushed.
 *     The API test setup (apps/api) already does this; see
 *     .claude/skills/test-api/SKILL.md for the bootstrap commands.
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
    // Fail fast with a clear message if the test DB isn't reachable.
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      throw new Error(
        `Cannot reach test database at ${process.env.DATABASE_URL}. ` +
          `Start Postgres (docker compose up -d postgres) and ensure the ` +
          `sruth_test database exists with the Prisma schema pushed.\n\n` +
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

  it('claims commands in FIFO order by createdAt', async () => {
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
    const handler = async (c: WorkerCommand) => { seen.push(c.sessionId); };

    await invokeProcessNext(consumer, handler);
    await invokeProcessNext(consumer, handler);
    await invokeProcessNext(consumer, handler);
    await invokeProcessNext(consumer, handler); // empty queue — must noop

    expect(seen).toEqual(['s-first', 's-second', 's-third']);
    expect(await prisma.workerCommand.count()).toBe(0);
  });

  it('discards (does not replay) a command when the handler throws', async () => {
    // This is the regression guard for the race condition that motivated the
    // fix. Under the previous two-step findFirst+delete design, a handler
    // throw left the row in the queue to be replayed — which corrupted state
    // for non-idempotent handlers like the full-session `stop` path. Under
    // the atomic DELETE ... RETURNING design, the row is gone at claim time
    // and a handler throw cannot trigger replay.
    await prisma.workerCommand.create({
      data: { id: 'c-crash', payload: cmd('s-crash') },
    });

    const callLog: string[] = [];
    const throwingHandler = async (c: WorkerCommand) => {
      callLog.push(`throw:${c.sessionId}`);
      throw new Error('simulated handler failure');
    };
    const trackingHandler = async (c: WorkerCommand) => {
      callLog.push(`track:${c.sessionId}`);
    };

    const consumer = new CommandConsumer(prisma, 10);

    await invokeProcessNext(consumer, throwingHandler);
    await invokeProcessNext(consumer, trackingHandler);

    expect(callLog).toEqual(['throw:s-crash']);
    expect(await prisma.workerCommand.count()).toBe(0);
  });

  it('two concurrent claims pick different rows (FOR UPDATE SKIP LOCKED)', async () => {
    // Two workers polling simultaneously must not both claim the same row.
    // This relies on Postgres row-locking in the subquery; the unit tests
    // mock Prisma and cannot exercise it.
    const now = Date.now();
    await prisma.workerCommand.createMany({
      data: [
        { id: 'c-a', payload: cmd('s-a'), createdAt: new Date(now - 2000) },
        { id: 'c-b', payload: cmd('s-b'), createdAt: new Date(now - 1000) },
      ],
    });

    const seen: string[] = [];
    const consumer = new CommandConsumer(prisma, 10);
    const handler = async (c: WorkerCommand) => { seen.push(c.sessionId); };

    await Promise.all([
      invokeProcessNext(consumer, handler),
      invokeProcessNext(consumer, handler),
    ]);

    expect(seen.sort()).toEqual(['s-a', 's-b']);
    expect(await prisma.workerCommand.count()).toBe(0);
  });
});
