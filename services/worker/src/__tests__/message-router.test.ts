import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkerCommand } from '@omega-stream/shared';

// Mock Redis before importing router
const mockRedisInstance = {
  set: vi.fn().mockResolvedValue('OK'),
  get: vi.fn().mockResolvedValue(null),
  del: vi.fn().mockResolvedValue(1),
  expire: vi.fn().mockResolvedValue(1),
  publish: vi.fn().mockResolvedValue(1),
  subscribe: vi.fn().mockResolvedValue(undefined),
  unsubscribe: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  quit: vi.fn().mockResolvedValue('OK'),
};

vi.mock('../redis.js', () => ({
  getRedis: () => mockRedisInstance,
  getSubscriber: () => mockRedisInstance,
  shutdownRedis: vi.fn(),
}));

import { MessageRouter } from '../message-router.js';

const WORKER_ID = 'worker-1';
const OTHER_WORKER_ID = 'worker-2';

const startCommand: WorkerCommand = {
  type: 'start',
  userId: 'user-1',
  sessionId: 'session-1',
  ingestIp: '10.0.1.1',
  streamKey: 'key-1',
  outputs: [{ outputSessionId: 'out-1', rtmpUrl: 'rtmp://twitch.tv/app', streamKey: 'live_xxx' }],
};

const stopCommand: WorkerCommand = {
  type: 'stop',
  userId: 'user-1',
  sessionId: 'session-1',
};

const relocateCommand: WorkerCommand = {
  type: 'ingest_relocated',
  userId: 'user-1',
  sessionId: 'session-1',
  newIngestIp: '10.0.2.1',
};

describe('MessageRouter', () => {
  let router: MessageRouter;
  const handler = vi.fn<(cmd: WorkerCommand) => Promise<void>>().mockResolvedValue(undefined);

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    router = new MessageRouter(WORKER_ID);
    await router.start(handler);
  });

  afterEach(async () => {
    await router.stop();
    vi.useRealTimers();
  });

  describe('heartbeat', () => {
    it('writes heartbeat on start', () => {
      expect(mockRedisInstance.set).toHaveBeenCalledWith(
        `worker:${WORKER_ID}:heartbeat`,
        '1',
        'EX',
        30,
      );
    });

    it('refreshes heartbeat every 10s', async () => {
      mockRedisInstance.set.mockClear();
      vi.advanceTimersByTime(10_000);
      // Allow the async heartbeat to resolve
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRedisInstance.set).toHaveBeenCalledWith(
        `worker:${WORKER_ID}:heartbeat`,
        '1',
        'EX',
        30,
      );
    });
  });

  describe('pub/sub subscription', () => {
    it('subscribes to worker channel', () => {
      expect(mockRedisInstance.subscribe).toHaveBeenCalledWith(
        `worker:${WORKER_ID}:commands`,
      );
    });

    it('handles messages from pub/sub channel', () => {
      // Find the 'message' callback registered via .on()
      const onCall = mockRedisInstance.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message',
      );
      expect(onCall).toBeTruthy();

      const messageHandler = onCall![1] as (ch: string, msg: string) => void;
      messageHandler(`worker:${WORKER_ID}:commands`, JSON.stringify(stopCommand));

      expect(handler).toHaveBeenCalledWith(stopCommand);
    });

    it('ignores messages from other channels', () => {
      const onCall = mockRedisInstance.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message',
      );
      const messageHandler = onCall![1] as (ch: string, msg: string) => void;
      messageHandler('other-channel', JSON.stringify(stopCommand));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('session registration', () => {
    it('registers session ownership', async () => {
      await router.registerSession('session-1');
      expect(mockRedisInstance.set).toHaveBeenCalledWith(
        'session:session-1:worker',
        WORKER_ID,
        'EX',
        120,
      );
    });

    it('refreshes session ownership TTL', async () => {
      await router.refreshSessionOwnership('session-1');
      expect(mockRedisInstance.expire).toHaveBeenCalledWith(
        'session:session-1:worker',
        120,
      );
    });

    it('unregisters session', async () => {
      await router.unregisterSession('session-1');
      expect(mockRedisInstance.del).toHaveBeenCalledWith('session:session-1:worker');
    });
  });

  describe('routeCommand', () => {
    it('always handles start commands locally', async () => {
      const result = await router.routeCommand(startCommand);
      expect(result).toBe(true);
      // Should not check ownership for start
      expect(mockRedisInstance.get).not.toHaveBeenCalledWith('session:session-1:worker');
    });

    it('handles commands for sessions this worker owns', async () => {
      mockRedisInstance.get.mockResolvedValueOnce(WORKER_ID);
      const result = await router.routeCommand(stopCommand);
      expect(result).toBe(true);
    });

    it('re-routes to alive owner via pub/sub', async () => {
      // First get: session owner
      mockRedisInstance.get.mockResolvedValueOnce(OTHER_WORKER_ID);
      // Second get: heartbeat check
      mockRedisInstance.get.mockResolvedValueOnce('1');

      const result = await router.routeCommand(stopCommand);

      expect(result).toBe(false);
      expect(mockRedisInstance.publish).toHaveBeenCalledWith(
        `worker:${OTHER_WORKER_ID}:commands`,
        JSON.stringify(stopCommand),
      );
    });

    it('drops stop for orphaned session (no owner)', async () => {
      mockRedisInstance.get.mockResolvedValueOnce(null);
      const result = await router.routeCommand(stopCommand);
      expect(result).toBe(false);
    });

    it('drops update/relocate for orphaned session (no owner)', async () => {
      mockRedisInstance.get.mockResolvedValueOnce(null);
      const result = await router.routeCommand(relocateCommand);
      expect(result).toBe(false);
    });

    it('cleans up and drops stop when owner is dead', async () => {
      // Owner exists but heartbeat expired
      mockRedisInstance.get.mockResolvedValueOnce(OTHER_WORKER_ID);
      mockRedisInstance.get.mockResolvedValueOnce(null); // no heartbeat

      const result = await router.routeCommand(stopCommand);

      expect(result).toBe(false);
      expect(mockRedisInstance.del).toHaveBeenCalledWith('session:session-1:worker');
    });

    it('cleans up and drops relocate when owner is dead', async () => {
      mockRedisInstance.get.mockResolvedValueOnce(OTHER_WORKER_ID);
      mockRedisInstance.get.mockResolvedValueOnce(null); // no heartbeat

      const result = await router.routeCommand(relocateCommand);

      expect(result).toBe(false);
      expect(mockRedisInstance.del).toHaveBeenCalledWith('session:session-1:worker');
    });
  });
});
