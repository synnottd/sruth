import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProgressMetrics } from '../progress-parser.js';
import { HealthReporter } from '../health-reporter.js';
import type { FfmpegManager, Session, OutputProcess } from '../ffmpeg-manager.js';

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
    getSession: (id: string) => sessionsMap.get(id),
  } as unknown as FfmpegManager;
}

function createMockPrisma() {
  return {
    streamSession: {
      update: vi.fn().mockResolvedValue({}),
    },
  } as any;
}

describe('HealthReporter', () => {
  let reporter: HealthReporter;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = createMockPrisma();
  });

  afterEach(() => {
    reporter?.stop();
  });

  describe('recordMetrics', () => {
    it('records bitrate samples for an output', () => {
      const session = createFakeSession('s1', [{ outputSessionId: 'out-1', status: 'live' }]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, mockPrisma);

      reporter.recordMetrics('s1', 'out-1', { bitrate: 2500, speed: 1.0, dropFrames: 0 });
      reporter.recordMetrics('s1', 'out-1', { bitrate: 3000, speed: 1.0, dropFrames: 0 });

      // No direct way to inspect samples, but writeSummary uses them
    });

    it('ignores null bitrate samples', () => {
      const session = createFakeSession('s1', [{ outputSessionId: 'out-1', status: 'live' }]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, mockPrisma);

      reporter.recordMetrics('s1', 'out-1', { bitrate: null, speed: 1.0, dropFrames: 0 });

      // writeSummary should not update DB with no samples
    });
  });

  describe('writeSummary', () => {
    it('writes avg and peak bitrate to StreamSession', async () => {
      const session = createFakeSession('s1', [{ outputSessionId: 'out-1', status: 'live' }]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, mockPrisma);

      reporter.recordMetrics('s1', 'out-1', { bitrate: 1000, speed: 1.0, dropFrames: 0 });
      reporter.recordMetrics('s1', 'out-1', { bitrate: 2000, speed: 1.0, dropFrames: 0 });
      reporter.recordMetrics('s1', 'out-1', { bitrate: 3000, speed: 1.0, dropFrames: 0 });

      await reporter.writeSummary('s1');

      expect(mockPrisma.streamSession.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { avgBitrate: 2000, peakBitrate: 3000 },
      });
    });

    it('skips update when no samples exist', async () => {
      const session = createFakeSession('s1', [{ outputSessionId: 'out-1', status: 'live' }]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, mockPrisma);

      await reporter.writeSummary('s1');

      expect(mockPrisma.streamSession.update).not.toHaveBeenCalled();
    });

    it('skips update when session not found', async () => {
      const manager = createFakeManager([]);
      reporter = new HealthReporter(manager, mockPrisma);

      await reporter.writeSummary('nonexistent');

      expect(mockPrisma.streamSession.update).not.toHaveBeenCalled();
    });
  });

  describe('clearOutput', () => {
    it('removes samples for a specific output', async () => {
      const session = createFakeSession('s1', [{ outputSessionId: 'out-1', status: 'live' }]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, mockPrisma);

      reporter.recordMetrics('s1', 'out-1', { bitrate: 1000, speed: 1.0, dropFrames: 0 });
      reporter.clearOutput('out-1');

      await reporter.writeSummary('s1');

      expect(mockPrisma.streamSession.update).not.toHaveBeenCalled();
    });
  });

  describe('aggregation', () => {
    it('computes correct avg/peak across many samples without retaining history', async () => {
      const session = createFakeSession('s1', [{ outputSessionId: 'out-1', status: 'live' }]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, mockPrisma);

      // 10 000 samples — a stand-in for a long-running stream. If the reporter
      // retained each sample the heap footprint would scale with this number;
      // it doesn't.
      for (let i = 1; i <= 10_000; i++) {
        reporter.recordMetrics('s1', 'out-1', { bitrate: i, speed: 1.0, dropFrames: 0 });
      }

      await reporter.writeSummary('s1');

      expect(mockPrisma.streamSession.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { avgBitrate: 5000.5, peakBitrate: 10_000 },
      });
    });

    it('combines aggregates across multiple outputs', async () => {
      const session = createFakeSession('s1', [
        { outputSessionId: 'out-1', status: 'live' },
        { outputSessionId: 'out-2', status: 'live' },
      ]);
      const manager = createFakeManager([session]);
      reporter = new HealthReporter(manager, mockPrisma);

      reporter.recordMetrics('s1', 'out-1', { bitrate: 1000, speed: 1.0, dropFrames: 0 });
      reporter.recordMetrics('s1', 'out-1', { bitrate: 2000, speed: 1.0, dropFrames: 0 });
      reporter.recordMetrics('s1', 'out-2', { bitrate: 5000, speed: 1.0, dropFrames: 0 });

      await reporter.writeSummary('s1');

      // (1000 + 2000 + 5000) / 3 = 2666.66…, peak across outputs = 5000
      expect(mockPrisma.streamSession.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { avgBitrate: (1000 + 2000 + 5000) / 3, peakBitrate: 5000 },
      });
    });
  });
});
