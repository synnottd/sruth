import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { WorkerCommand } from '@sruth/shared';
import { CommandConsumer } from '../command-consumer.js';

/**
 * Minimal shape of the Prisma surface CommandConsumer actually touches.
 * PrismaClient is dependency-injected via the constructor, so we don't need
 * module-level mocking — a plain object cast as `unknown as PrismaClient`
 * is enough.
 *
 * The consumer uses `$queryRaw` with an atomic DELETE ... RETURNING so that
 * claiming a command and removing it from the queue happen in one statement.
 * These tests drive `processNext` directly to avoid the polling timer.
 */
type MockPrisma = {
  $queryRaw: ReturnType<typeof vi.fn>;
};

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

describe('CommandConsumer', () => {
  let mockPrisma: MockPrisma;

  beforeEach(() => {
    mockPrisma = { $queryRaw: vi.fn() };
  });

  it('hands each command to the handler at most once across repeated polls', async () => {
    // The atomic claim returns the row on the first poll and leaves the
    // queue empty afterwards. Two poll cycles should therefore produce
    // exactly one handler invocation — the command cannot be replayed.
    const command: WorkerCommand = {
      type: 'stop',
      userId: 'user-1',
      sessionId: 'session-1',
    };

    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ payload: command }])
      .mockResolvedValue([]);

    const handler = vi
      .fn<(c: WorkerCommand) => Promise<void>>()
      .mockResolvedValue(undefined);

    const consumer = new CommandConsumer(
      mockPrisma as unknown as PrismaClient,
      10,
    );

    await invokeProcessNext(consumer, handler);
    await invokeProcessNext(consumer, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(command);
  });

  it('does not replay a command when the handler throws (at-most-once)', async () => {
    // The row is atomically removed at claim time, so a handler failure
    // discards the command rather than triggering an infinite retry loop.
    // This is a deliberate trade-off: several handlers are not idempotent,
    // so replay can corrupt DB state. Operators should watch logs for the
    // discard warning.
    const command: WorkerCommand = {
      type: 'stop',
      userId: 'user-1',
      sessionId: 'session-1',
    };

    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ payload: command }])
      .mockResolvedValue([]);

    const handler = vi
      .fn<(c: WorkerCommand) => Promise<void>>()
      .mockRejectedValue(new Error('handler blew up'));

    const consumer = new CommandConsumer(
      mockPrisma as unknown as PrismaClient,
      10,
    );

    // Silence the expected error log so the test output stays clean.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await invokeProcessNext(consumer, handler);
    await invokeProcessNext(consumer, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      '[CommandConsumer] Handler failed — command discarded:',
      'stop',
      'session-1',
      expect.any(Error),
    );

    errSpy.mockRestore();
  });

  it('does nothing when the queue is empty', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);

    const handler = vi
      .fn<(c: WorkerCommand) => Promise<void>>()
      .mockResolvedValue(undefined);

    const consumer = new CommandConsumer(
      mockPrisma as unknown as PrismaClient,
      10,
    );

    await invokeProcessNext(consumer, handler);

    expect(handler).not.toHaveBeenCalled();
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
