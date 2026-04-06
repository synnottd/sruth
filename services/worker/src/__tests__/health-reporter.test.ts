import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProgressMetrics } from '../progress-parser.js';

// Mock Redis
const pipelineExec = vi.fn().mockResolvedValue([]);
const mockPipeline = {
  set: vi.fn().mockReturnThis(),
  del: vi.fn().mockReturnThis(),
  hset: vi.fn().mockReturnThis(),
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

import {
  HealthReporter,
  type CloudWatchPublisher,
  type CloudWatchMetricDatum,
} from '../health-reporter.js';
import type { FfmpegManager, Session, OutputProcess } from '../ffmpeg-manager.js';
import type { MessageRouter } from '../message-router.js';

// Helpers to create minimal fakes
function createFakeSession(sessionId: string, outputs: Partial<OutputProcess>[]): Session {
  const outputMap = new Map<string, OutputProcess>();
  for (const o of outputs) {
    const full: OutputProcess = {
      outputSessionId: o.outputSessionId ?? 'out-1',
      rtmpUrl: o.rtmpUrl ?? 'rtmp://test',
      streamKey: o.streamKey ?? 'key',
      process: null,
      abortController: new AbortController(),
      retryCount: o.retryCount ?? 0,
      status: o.status ?? 'live',
      lastError: o.lastError ?? null,
      lastMetrics: o.lastMetrics ?? null,
      stderrBuffer: [],
    };
    outputMap.set(full.outputSessionId, full);
  }
  return {
    sessionId,
    userId: 'user-1',
    streamKey: 'stream-key',
    ingestIp: '10.0.1.1',
    outputs: outputMap,
  };
}

function createFakeManager(sessions: Session[]): FfmpegManager {
  const sessionsMap = new Map(sessions.map((s) => [s.sessionId, s]));
  return {
    getSessions: () => sessionsMap,
  } as unknown as FfmpegManager;
}

function createFakeRouter(): MessageRouter & { refreshCalls: string[] } {
  const refreshCalls: string[] = [];
  return {
    refreshCalls,
    refreshSessionOwnership: vi.fn(async (sessionId: string) => {
      refreshCalls.push(sessionId);
    }),
  } as unknown as MessageRouter & { refreshCalls: string[] };
}

describe('HealthReporter', () => {
  let reporter: HealthReporter;
  let cwPublisher: CloudWatchPublisher & { calls: CloudWatchMetricDatum[][] };
  let fakeRouter: ReturnType<typeof createFakeRouter>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    cwPublisher = {
      calls: [],
      putMetrics: vi.fn(async (data: CloudWatchMetricDatum[]) => {
        cwPublisher.calls.push(data);
      }),
    };
    fakeRouter = createFakeRouter();
  });

  afterEach(() => {
    reporter?.stop();
    vi.useRealTimers();
  });

  describe('flushToRedis', () => {
    it('writes bitrate, status, and health keys for active sessions', async () => {
      const session = createFakeSession('s1', [
        {
          outputSessionId: 'out-1',
          status: 'live',
          lastMetrics: { bitrate: 2500, speed: 1.0, dropFrames: 3 },
          retryCount: 0,
        },
      ]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, fakeRouter, cwPublisher);

      await reporter.flushToRedis();

      // Bitrate key
      expect(mockPipeline.set).toHaveBeenCalledWith('stream:s1:bitrate', '2500', 'EX', 10);

      // Status hash
      expect(mockPipeline.hset).toHaveBeenCalledWith(
        'stream:s1:status',
        'out-1', 'live',
      );
      expect(mockPipeline.expire).toHaveBeenCalledWith('stream:s1:status', 120);

      // Health hash
      expect(mockPipeline.hset).toHaveBeenCalledWith(
        'stream:s1:health',
        'out-1:dropFrames', '3',
        'out-1:reconnectCount', '0',
      );
      expect(mockPipeline.expire).toHaveBeenCalledWith('stream:s1:health', 30);

      expect(pipelineExec).toHaveBeenCalled();
    });

    it('refreshes session ownership TTL', async () => {
      const session = createFakeSession('s1', [{ outputSessionId: 'out-1', status: 'live' }]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, fakeRouter, cwPublisher);

      await reporter.flushToRedis();

      expect(fakeRouter.refreshCalls).toContain('s1');
    });

    it('skips bitrate key when no metrics available', async () => {
      const session = createFakeSession('s1', [
        { outputSessionId: 'out-1', status: 'starting', lastMetrics: null },
      ]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, fakeRouter, cwPublisher);

      await reporter.flushToRedis();

      expect(mockPipeline.set).not.toHaveBeenCalledWith(
        expect.stringContaining('bitrate'),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('handles multiple sessions', async () => {
      const s1 = createFakeSession('s1', [
        { outputSessionId: 'out-1', status: 'live', lastMetrics: { bitrate: 1000, speed: 1.0, dropFrames: 0 } },
      ]);
      const s2 = createFakeSession('s2', [
        { outputSessionId: 'out-2', status: 'retrying', lastMetrics: { bitrate: 500, speed: 0.5, dropFrames: 1 } },
      ]);
      const manager = createFakeManager([s1, s2]);
      reporter = new HealthReporter(manager, fakeRouter, cwPublisher);

      await reporter.flushToRedis();

      // Two pipeline.exec calls (one per session)
      expect(pipelineExec).toHaveBeenCalledTimes(2);
    });
  });

  describe('flushToCloudWatch', () => {
    it('aggregates bitrate samples into StatisticValues', async () => {
      const session = createFakeSession('s1', [{ outputSessionId: 'out-1', status: 'live' }]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, fakeRouter, cwPublisher);

      // Record several samples
      reporter.recordMetrics('s1', 'out-1', { bitrate: 1000, speed: 1.0, dropFrames: 0 });
      reporter.recordMetrics('s1', 'out-1', { bitrate: 2000, speed: 1.0, dropFrames: 0 });
      reporter.recordMetrics('s1', 'out-1', { bitrate: 1500, speed: 1.0, dropFrames: 0 });

      await reporter.flushToCloudWatch();

      expect(cwPublisher.putMetrics).toHaveBeenCalledTimes(1);
      const data = cwPublisher.calls[0];
      expect(data).toHaveLength(1);
      expect(data[0].metricName).toBe('Bitrate');
      expect(data[0].statisticValues).toEqual({
        minimum: 1000,
        maximum: 2000,
        sum: 4500,
        sampleCount: 3,
      });
      expect(data[0].dimensions).toEqual([
        { name: 'SessionId', value: 's1' },
        { name: 'OutputSessionId', value: 'out-1' },
      ]);
    });

    it('clears samples after flush', async () => {
      const session = createFakeSession('s1', [{ outputSessionId: 'out-1', status: 'live' }]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, fakeRouter, cwPublisher);

      reporter.recordMetrics('s1', 'out-1', { bitrate: 1000, speed: 1.0, dropFrames: 0 });
      await reporter.flushToCloudWatch();

      // Second flush should have no data
      await reporter.flushToCloudWatch();
      expect(cwPublisher.putMetrics).toHaveBeenCalledTimes(1); // Only the first call
    });

    it('skips outputs with no samples', async () => {
      const session = createFakeSession('s1', [{ outputSessionId: 'out-1', status: 'live' }]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, fakeRouter, cwPublisher);

      await reporter.flushToCloudWatch();

      expect(cwPublisher.putMetrics).not.toHaveBeenCalled();
    });

    it('ignores null bitrate samples', async () => {
      const session = createFakeSession('s1', [{ outputSessionId: 'out-1', status: 'live' }]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, fakeRouter, cwPublisher);

      reporter.recordMetrics('s1', 'out-1', { bitrate: null, speed: 1.0, dropFrames: 0 });

      await reporter.flushToCloudWatch();

      expect(cwPublisher.putMetrics).not.toHaveBeenCalled();
    });
  });

  describe('OutputErrorDuration metric', () => {
    it('publishes error duration on CloudWatch flush', async () => {
      const session = createFakeSession('s1', [{ outputSessionId: 'out-1', status: 'error' }]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, fakeRouter, cwPublisher);

      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      reporter.reportError('s1', 'out-1');

      // Advance 90 seconds
      vi.setSystemTime(new Date('2026-01-01T00:01:30Z'));
      await reporter.flushToCloudWatch();

      expect(cwPublisher.putMetrics).toHaveBeenCalledTimes(1);
      const data = cwPublisher.calls[0];
      const errorMetric = data.find((d) => d.metricName === 'OutputErrorDuration');
      expect(errorMetric).toBeDefined();
      expect(errorMetric!.statisticValues.maximum).toBeCloseTo(90, 0);
      expect(errorMetric!.unit).toBe('Seconds');
      expect(errorMetric!.dimensions).toEqual([
        { name: 'SessionId', value: 's1' },
        { name: 'OutputSessionId', value: 'out-1' },
      ]);
    });

    it('stops publishing after error is cleared', async () => {
      const session = createFakeSession('s1', [{ outputSessionId: 'out-1', status: 'error' }]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, fakeRouter, cwPublisher);

      reporter.reportError('s1', 'out-1');
      reporter.clearError('out-1');

      await reporter.flushToCloudWatch();
      expect(cwPublisher.putMetrics).not.toHaveBeenCalled();
    });

    it('does not double-report if reportError called multiple times', async () => {
      const session = createFakeSession('s1', [{ outputSessionId: 'out-1', status: 'error' }]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, fakeRouter, cwPublisher);

      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      reporter.reportError('s1', 'out-1');

      vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
      reporter.reportError('s1', 'out-1'); // Should not reset enteredAt

      vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
      await reporter.flushToCloudWatch();

      const data = cwPublisher.calls[0];
      const errorMetric = data.find((d) => d.metricName === 'OutputErrorDuration');
      // Duration should be 60s from first report, not 30s from second
      expect(errorMetric!.statisticValues.maximum).toBeCloseTo(60, 0);
    });
  });

  describe('timers', () => {
    it('flushes to Redis every 5 seconds', async () => {
      const session = createFakeSession('s1', [{ outputSessionId: 'out-1', status: 'live' }]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, fakeRouter, cwPublisher);
      reporter.start();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(pipelineExec).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(pipelineExec).toHaveBeenCalledTimes(2);
    });

    it('flushes to CloudWatch every 60 seconds', async () => {
      const session = createFakeSession('s1', [{ outputSessionId: 'out-1', status: 'live' }]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, fakeRouter, cwPublisher);
      reporter.start();

      reporter.recordMetrics('s1', 'out-1', { bitrate: 1000, speed: 1.0, dropFrames: 0 });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(cwPublisher.putMetrics).toHaveBeenCalledTimes(1);
    });

    it('stops timers on stop()', async () => {
      const session = createFakeSession('s1', [{ outputSessionId: 'out-1', status: 'live' }]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, fakeRouter, cwPublisher);
      reporter.start();
      reporter.stop();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(pipelineExec).not.toHaveBeenCalled();
    });
  });
});
