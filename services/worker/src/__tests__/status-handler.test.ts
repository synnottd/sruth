import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStatusHandler, type StatusHandlerDeps } from '../status-handler.js';

type PrismaMock = StatusHandlerDeps['prisma'];

function fakePrisma(overrides: {
  outputUpdate?: (args: unknown) => Promise<unknown>;
  sessionUpdateMany?: (args: unknown) => Promise<unknown>;
} = {}): { prisma: PrismaMock; outputUpdate: ReturnType<typeof vi.fn>; sessionUpdateMany: ReturnType<typeof vi.fn> } {
  const outputUpdate = vi.fn(overrides.outputUpdate ?? (async () => ({})));
  const sessionUpdateMany = vi.fn(overrides.sessionUpdateMany ?? (async () => ({ count: 1 })));
  // `$transaction([...])` resolves the array of Prisma promises — the fake ones
  // are already plain Promises, so await them in order.
  const $transaction = vi.fn((ops: Promise<unknown>[]) => Promise.all(ops));
  const prisma = {
    outputSession: { update: outputUpdate },
    streamSession: { updateMany: sessionUpdateMany },
    $transaction,
  } as unknown as PrismaMock;
  return { prisma, outputUpdate, sessionUpdateMany };
}

describe('createStatusHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists live status by updating OutputSession and StreamSession', async () => {
    const { prisma, outputUpdate, sessionUpdateMany } = fakePrisma();
    const onSse = vi.fn();

    const handler = createStatusHandler({
      prisma,
      onSse,
      maxRetries: 3,
      retryDelayMs: 10,
    });

    handler.onStatusChange('sess-1', 'out-1', 'live', null);
    await vi.runAllTimersAsync();
    await handler.flush();

    expect(outputUpdate).toHaveBeenCalledWith({
      where: { id: 'out-1' },
      data: expect.objectContaining({ status: 'LIVE', lastError: null }),
    });
    expect(sessionUpdateMany).toHaveBeenCalledWith({
      where: { id: 'sess-1', status: 'STARTING' },
      data: { status: 'LIVE' },
    });
    expect(onSse).toHaveBeenCalledWith('sess-1', 'out-1', 'live', null);
  });

  it('persists error status with lastError', async () => {
    const { prisma, outputUpdate, sessionUpdateMany } = fakePrisma();
    const handler = createStatusHandler({
      prisma,
      onSse: vi.fn(),
      maxRetries: 3,
      retryDelayMs: 10,
    });

    handler.onStatusChange('sess-1', 'out-1', 'error', 'rtmp refused');
    await vi.runAllTimersAsync();
    await handler.flush();

    expect(outputUpdate).toHaveBeenCalledWith({
      where: { id: 'out-1' },
      data: expect.objectContaining({ status: 'ERROR', lastError: 'rtmp refused' }),
    });
    // error status should NOT touch StreamSession
    expect(sessionUpdateMany).not.toHaveBeenCalled();
  });

  it('does not write to DB for starting or stopped statuses', async () => {
    const { prisma, outputUpdate, sessionUpdateMany } = fakePrisma();
    const onSse = vi.fn();
    const handler = createStatusHandler({
      prisma,
      onSse,
      maxRetries: 3,
      retryDelayMs: 10,
    });

    handler.onStatusChange('s', 'o', 'starting', null);
    handler.onStatusChange('s', 'o', 'stopped', null);
    await vi.runAllTimersAsync();
    await handler.flush();

    expect(outputUpdate).not.toHaveBeenCalled();
    expect(sessionUpdateMany).not.toHaveBeenCalled();
    // SSE is still pushed for every status change
    expect(onSse).toHaveBeenCalledTimes(2);
  });

  it('persists retrying status and increments reconnectCount', async () => {
    const { prisma, outputUpdate, sessionUpdateMany } = fakePrisma();
    const handler = createStatusHandler({
      prisma,
      onSse: vi.fn(),
      maxRetries: 3,
      retryDelayMs: 10,
    });

    handler.onStatusChange('sess-1', 'out-1', 'retrying', null);
    await vi.runAllTimersAsync();
    await handler.flush();

    expect(outputUpdate).toHaveBeenCalledWith({
      where: { id: 'out-1' },
      data: expect.objectContaining({
        status: 'RETRYING',
        reconnectCount: { increment: 1 },
      }),
    });
    // retrying should NOT touch StreamSession
    expect(sessionUpdateMany).not.toHaveBeenCalled();
  });

  it('resets reconnectCount on live status', async () => {
    const { prisma, outputUpdate } = fakePrisma();
    const handler = createStatusHandler({
      prisma,
      onSse: vi.fn(),
      maxRetries: 3,
      retryDelayMs: 10,
    });

    handler.onStatusChange('sess-1', 'out-1', 'live', null);
    await vi.runAllTimersAsync();
    await handler.flush();

    expect(outputUpdate).toHaveBeenCalledWith({
      where: { id: 'out-1' },
      data: expect.objectContaining({
        status: 'LIVE',
        reconnectCount: 0,
      }),
    });
  });

  it('retries DB update on transient failure and eventually persists', async () => {
    // This is the regression guard for the fire-and-forget bug.
    // Under the previous design, a single `.catch(log)` dropped transient
    // failures, so `recoverSessions()` on restart would see stale status.
    let calls = 0;
    const { prisma, outputUpdate } = fakePrisma({
      outputUpdate: async () => {
        calls++;
        if (calls < 3) throw new Error('ECONNREFUSED');
        return {};
      },
    });
    const handler = createStatusHandler({
      prisma,
      onSse: vi.fn(),
      maxRetries: 5,
      retryDelayMs: 10,
    });

    handler.onStatusChange('sess-1', 'out-1', 'live', null);
    await vi.runAllTimersAsync();
    await handler.flush();

    expect(outputUpdate).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries and logs without throwing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { prisma, outputUpdate } = fakePrisma({
      outputUpdate: async () => { throw new Error('permanent failure'); },
    });
    const handler = createStatusHandler({
      prisma,
      onSse: vi.fn(),
      maxRetries: 3,
      retryDelayMs: 10,
    });

    handler.onStatusChange('sess-1', 'out-1', 'live', null);
    await vi.runAllTimersAsync();
    await expect(handler.flush()).resolves.toBeUndefined();

    expect(outputUpdate).toHaveBeenCalledTimes(3);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('processes queued updates serially in FIFO order', async () => {
    const order: string[] = [];
    const { prisma } = fakePrisma({
      outputUpdate: async (args: unknown) => {
        const { where } = args as { where: { id: string } };
        order.push(where.id);
        return {};
      },
    });
    const handler = createStatusHandler({
      prisma,
      onSse: vi.fn(),
      maxRetries: 3,
      retryDelayMs: 10,
    });

    handler.onStatusChange('s', 'out-a', 'live', null);
    handler.onStatusChange('s', 'out-b', 'error', 'boom');
    handler.onStatusChange('s', 'out-c', 'live', null);
    await vi.runAllTimersAsync();
    await handler.flush();

    expect(order).toEqual(['out-a', 'out-b', 'out-c']);
  });
});
