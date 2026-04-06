import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Redis
const pipelineExec = vi.fn().mockResolvedValue([]);
const mockPipeline = {
  lpush: vi.fn().mockReturnThis(),
  ltrim: vi.fn().mockReturnThis(),
  expire: vi.fn().mockReturnThis(),
  exec: pipelineExec,
};
const mockRedis = {
  pipeline: vi.fn(() => mockPipeline),
};

vi.mock('../redis.js', () => ({
  getRedis: () => mockRedis,
  getSubscriber: () => mockRedis,
  shutdownRedis: vi.fn(),
}));

import { LogCapture, type CloudWatchLogsPublisher } from '../log-capture.js';

describe('LogCapture', () => {
  let capture: LogCapture;
  let cwCalls: Array<{ logGroup: string; logStream: string; events: Array<{ timestamp: number; message: string }> }>;
  let cwPublisher: CloudWatchLogsPublisher;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    cwCalls = [];
    cwPublisher = {
      putLogEvents: vi.fn(async (logGroup, logStream, events) => {
        cwCalls.push({ logGroup, logStream, events });
      }),
    };
    capture = new LogCapture(cwPublisher);
  });

  afterEach(() => {
    capture.stop();
    vi.useRealTimers();
  });

  describe('Redis writes', () => {
    it('writes each line to Redis list with LPUSH + LTRIM + EXPIRE', async () => {
      await capture.captureLine('s1', 'out-1', 'some log line');

      expect(mockPipeline.lpush).toHaveBeenCalledWith('stream:s1:logs:out-1', 'some log line');
      expect(mockPipeline.ltrim).toHaveBeenCalledWith('stream:s1:logs:out-1', 0, 199);
      expect(mockPipeline.expire).toHaveBeenCalledWith('stream:s1:logs:out-1', 300);
      expect(pipelineExec).toHaveBeenCalled();
    });

    it('writes to correct key for different outputs', async () => {
      await capture.captureLine('s1', 'out-1', 'line 1');
      await capture.captureLine('s1', 'out-2', 'line 2');

      expect(mockPipeline.lpush).toHaveBeenCalledWith('stream:s1:logs:out-1', 'line 1');
      expect(mockPipeline.lpush).toHaveBeenCalledWith('stream:s1:logs:out-2', 'line 2');
    });
  });

  describe('CloudWatch buffering', () => {
    it('buffers lines and flushes every 5 seconds', async () => {
      capture.start();

      await capture.captureLine('s1', 'out-1', 'line 1');
      await capture.captureLine('s1', 'out-1', 'line 2');

      // Not yet flushed
      expect(cwCalls).toHaveLength(0);

      // Advance past flush interval
      await vi.advanceTimersByTimeAsync(5_000);

      expect(cwCalls).toHaveLength(1);
      expect(cwCalls[0].logGroup).toBe('/omega-stream/worker/ffmpeg');
      expect(cwCalls[0].logStream).toBe('s1/out-1');
      expect(cwCalls[0].events).toHaveLength(2);
      expect(cwCalls[0].events[0].message).toBe('line 1');
      expect(cwCalls[0].events[1].message).toBe('line 2');
    });

    it('flushes immediately when buffer reaches 50 lines', async () => {
      for (let i = 0; i < 50; i++) {
        await capture.captureLine('s1', 'out-1', `line ${i}`);
      }

      // Should have flushed at line 50 without waiting for timer
      expect(cwCalls).toHaveLength(1);
      expect(cwCalls[0].events).toHaveLength(50);
    });

    it('does not flush empty buffers', async () => {
      capture.start();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(cwCalls).toHaveLength(0);
    });

    it('handles multiple outputs independently', async () => {
      capture.start();

      await capture.captureLine('s1', 'out-1', 'a');
      await capture.captureLine('s1', 'out-2', 'b');

      await vi.advanceTimersByTimeAsync(5_000);

      expect(cwCalls).toHaveLength(2);
      const streams = cwCalls.map((c) => c.logStream).sort();
      expect(streams).toEqual(['s1/out-1', 's1/out-2']);
    });
  });

  describe('removeOutput', () => {
    it('flushes remaining buffer and removes output', async () => {
      await capture.captureLine('s1', 'out-1', 'final line');
      await capture.removeOutput('out-1');

      expect(cwCalls).toHaveLength(1);
      expect(cwCalls[0].events[0].message).toBe('final line');
    });

    it('handles removal of unknown output gracefully', async () => {
      await expect(capture.removeOutput('unknown')).resolves.toBeUndefined();
    });
  });
});
