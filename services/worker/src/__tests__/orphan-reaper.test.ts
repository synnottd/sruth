import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { start, sweep } from '../orphan-reaper.js';

/**
 * Unit tests for the orphan reaper's scheduling behaviour.
 *
 * The SQL itself is exercised by the integration test; these tests drive the
 * interval / startup-sweep orchestration with fake timers and a mocked Prisma.
 */
type MockPrisma = {
  $executeRaw: ReturnType<typeof vi.fn>;
};

describe('orphan-reaper scheduling', () => {
  let mockPrisma: MockPrisma;

  beforeEach(() => {
    vi.useFakeTimers();
    mockPrisma = { $executeRaw: vi.fn().mockResolvedValue(0) };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() runs an immediate sweep and then one sweep per interval', async () => {
    const reaper = start(mockPrisma as unknown as PrismaClient, {
      intervalMs: 60_000,
      staleAfterMs: 5 * 60_000,
    });

    // Flush the startup sweep's microtasks.
    await vi.advanceTimersByTimeAsync(0);
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(3);

    reaper.stop();
  });

  it('stop() halts further periodic sweeps', async () => {
    const reaper = start(mockPrisma as unknown as PrismaClient, {
      intervalMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    reaper.stop();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // Only the startup sweep should have fired.
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('sweep() delegates to $executeRaw (cutoff derived from staleAfterMs)', async () => {
    await sweep(mockPrisma as unknown as PrismaClient, { staleAfterMs: 5 * 60_000 });
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
