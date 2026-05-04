import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createStatusHandler } from '../src/status-handler.js';

/**
 * Integration tests for the status-handler DB writes against a real Postgres.
 *
 * These exercise the retry-on-failure path end-to-end: they use a Prisma proxy
 * that rejects the first N calls before delegating to the real client, so we
 * verify that transient DB errors no longer silently lose the status update
 * (the "fire-and-forget" bug the handler was written to fix).
 *
 * Prereqs:
 *   - Postgres running (project-root `docker-compose.yml`).
 *   - `sruth_test` database exists with the Prisma schema pushed.
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function seed(): Promise<{ userId: string; sessionId: string; outputSessionId: string }> {
  const user = await prisma.user.create({
    data: { email: `t-${Date.now()}@example.com`, passwordHash: 'x' },
  });
  const output = await prisma.output.create({
    data: {
      userId: user.id,
      name: 'Test',
      platform: 'CUSTOM',
      rtmpUrl: 'rtmp://example.com/live',
      streamKey: 'sk',
    },
  });
  const session = await prisma.streamSession.create({
    data: { userId: user.id, status: 'STARTING' },
  });
  const outputSession = await prisma.outputSession.create({
    data: { sessionId: session.id, outputId: output.id, status: 'STARTING' },
  });
  return { userId: user.id, sessionId: session.id, outputSessionId: outputSession.id };
}

describe('status-handler integration (real Postgres)', { timeout: 30_000 }, () => {
  beforeAll(async () => {
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
    await prisma.$executeRawUnsafe(
      'TRUNCATE "RefreshToken", "WorkerCommand", "OutputSession", "StreamSession", "Output", "User" CASCADE',
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('persists a LIVE status change end-to-end', async () => {
    const { sessionId, outputSessionId } = await seed();

    const handler = createStatusHandler({
      prisma,
      onSse: () => {},
      maxRetries: 3,
      retryDelayMs: 10,
    });

    handler.onStatusChange(sessionId, outputSessionId, 'live', null);
    await handler.flush();

    const os = await prisma.outputSession.findUnique({ where: { id: outputSessionId } });
    const ss = await prisma.streamSession.findUnique({ where: { id: sessionId } });
    expect(os?.status).toBe('LIVE');
    expect(ss?.status).toBe('LIVE');
  });

  it('persists a RETRYING status change', async () => {
    const { sessionId, outputSessionId } = await seed();

    const handler = createStatusHandler({
      prisma,
      onSse: () => {},
      maxRetries: 3,
      retryDelayMs: 10,
    });

    handler.onStatusChange(sessionId, outputSessionId, 'retrying', null);
    await handler.flush();

    const os = await prisma.outputSession.findUnique({ where: { id: outputSessionId } });
    expect(os?.status).toBe('RETRYING');
  });

  it('increments reconnectCount on each retrying event', async () => {
    const { sessionId, outputSessionId } = await seed();

    const handler = createStatusHandler({
      prisma,
      onSse: () => {},
      maxRetries: 3,
      retryDelayMs: 10,
    });

    handler.onStatusChange(sessionId, outputSessionId, 'retrying', null);
    handler.onStatusChange(sessionId, outputSessionId, 'retrying', null);
    handler.onStatusChange(sessionId, outputSessionId, 'retrying', null);
    await handler.flush();

    const os = await prisma.outputSession.findUnique({ where: { id: outputSessionId } });
    expect(os?.reconnectCount).toBe(3);
  });

  it('resets reconnectCount to 0 on live', async () => {
    const { sessionId, outputSessionId } = await seed();

    // Seed some retries first
    await prisma.outputSession.update({
      where: { id: outputSessionId },
      data: { reconnectCount: 5, status: 'RETRYING' },
    });

    const handler = createStatusHandler({
      prisma,
      onSse: () => {},
      maxRetries: 3,
      retryDelayMs: 10,
    });

    handler.onStatusChange(sessionId, outputSessionId, 'live', null);
    await handler.flush();

    const os = await prisma.outputSession.findUnique({ where: { id: outputSessionId } });
    expect(os?.status).toBe('LIVE');
    expect(os?.reconnectCount).toBe(0);
  });

  it('recovers from a transient DB failure and persists the final status', async () => {
    // Regression guard: without retry, this test fails because the first
    // rejection is swallowed by `.catch(log)` and the DB row is never updated.
    const { sessionId, outputSessionId } = await seed();

    let updateCalls = 0;
    const realUpdate = prisma.outputSession.update.bind(prisma.outputSession);
    const flakyUpdate = vi.fn(async (args: Parameters<typeof realUpdate>[0]) => {
      updateCalls++;
      if (updateCalls === 1) throw new Error('simulated transient failure');
      return realUpdate(args);
    });

    const flakyPrisma = {
      ...prisma,
      outputSession: { ...prisma.outputSession, update: flakyUpdate },
      streamSession: prisma.streamSession,
    } as unknown as PrismaClient;

    const handler = createStatusHandler({
      prisma: flakyPrisma,
      onSse: () => {},
      maxRetries: 3,
      retryDelayMs: 20,
    });

    handler.onStatusChange(sessionId, outputSessionId, 'error', 'rtmp refused');
    await handler.flush();

    expect(flakyUpdate).toHaveBeenCalledTimes(2);
    const os = await prisma.outputSession.findUnique({ where: { id: outputSessionId } });
    expect(os?.status).toBe('ERROR');
    expect(os?.lastError).toBe('rtmp refused');
  });
});
