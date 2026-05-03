import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { WorkerCommand } from '@sruth/shared';
import { CommandConsumer } from '../command-consumer.js';

/**
 * Unit tests for CommandConsumer's orchestration: claim → handler → settle.
 *
 * The integration tests cover the SQL itself (status transitions, FIFO,
 * FOR UPDATE SKIP LOCKED). These tests drive `processNext` with a mocked
 * Prisma surface to verify the consumer's externally-visible behaviour:
 * which handler was invoked with which payload, and that a settle update
 * happens after each handler run.
 */
type MockPrisma = {
  $queryRaw: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
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
    mockPrisma = {
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
  });

  it('hands each claimed command to the handler exactly once', async () => {
    const command: WorkerCommand = {
      type: 'stop',
      userId: 'user-1',
      sessionId: 'session-1',
    };

    // First poll claims the row, second finds the queue empty.
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'c-1', payload: command }])
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

  it('settles the row with a DONE update after the handler resolves', async () => {
    const command: WorkerCommand = {
      type: 'stop',
      userId: 'user-1',
      sessionId: 'session-1',
    };

    mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: 'c-1', payload: command }]);

    const consumer = new CommandConsumer(
      mockPrisma as unknown as PrismaClient,
      10,
    );

    await invokeProcessNext(consumer, async () => {
      /* success */
    });

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('settles the row with a FAILED update when the handler throws', async () => {
    const command: WorkerCommand = {
      type: 'stop',
      userId: 'user-1',
      sessionId: 'session-1',
    };

    mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: 'c-1', payload: command }]);

    const consumer = new CommandConsumer(
      mockPrisma as unknown as PrismaClient,
      10,
    );

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await invokeProcessNext(consumer, async () => {
      throw new Error('boom');
    });
    errSpy.mockRestore();

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the queue has no PENDING rows', async () => {
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
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });
});
