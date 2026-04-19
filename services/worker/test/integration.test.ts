import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { StartCommand } from '@sruth/shared';
import { FfmpegManager, type FfmpegManagerEvents, type OutputStatus } from '../src/ffmpeg-manager.js';
import type { ProgressMetrics } from '../src/progress-parser.js';

// Integration test config — uses worker docker-compose ports
const INGEST_IP = '127.0.0.1';  // localhost, port 1935
const SINK_RTMP_URL = 'rtmp://127.0.0.1:1936/live';
const STREAM_KEY = 'test-key';

let testStreamProcess: ChildProcess | null = null;

/** Push a test stream to the ingest server using FFmpeg test pattern generator. */
function startTestStream(streamKey: string): ChildProcess {
  return spawn('ffmpeg', [
    '-re',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-b:v', '500k',
    '-c:a', 'aac', '-b:a', '64k',
    '-f', 'flv',
    `rtmp://${INGEST_IP}:1935/live/${streamKey}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function killProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) { resolve(); return; }
    proc.once('close', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => { proc.kill('SIGKILL'); }, 3000);
  });
}

function workerDir(): string {
  return new URL('..', import.meta.url).pathname;
}

function isDockerComposeUp(): boolean {
  try {
    const result = execSync(
      'docker compose ps --format json 2>/dev/null',
      { cwd: workerDir(), encoding: 'utf-8', timeout: 5000 },
    );
    const lines = result.trim().split('\n').filter(Boolean);
    const services = lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    return services.length >= 2 && services.every((s: { State: string }) => s.State === 'running');
  } catch {
    return false;
  }
}

describe('Worker Integration Tests', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    if (!isDockerComposeUp()) {
      console.log('Starting docker-compose...');
      execSync('docker compose up -d --wait', {
        cwd: workerDir(),
        stdio: 'inherit',
        timeout: 90_000,
      });
    }

    await sleep(2000);
  }, 120_000);

  afterEach(async () => {
    if (testStreamProcess) {
      await killProcess(testStreamProcess);
      testStreamProcess = null;
    }
  });

  afterAll(async () => {
    if (testStreamProcess) {
      await killProcess(testStreamProcess);
    }
  });

  describe('FFmpeg process manager with real FFmpeg', () => {
    it('spawns FFmpeg, streams through ingest to sink, and reports metrics', async () => {
      testStreamProcess = startTestStream(STREAM_KEY);
      await sleep(3000); // Let the stream establish at ingest

      const statusChanges: Array<{ outputSessionId: string; status: OutputStatus }> = [];
      const metricsReceived: ProgressMetrics[] = [];

      const events: FfmpegManagerEvents = {
        onStatusChange: (_sid, oid, status) => { statusChanges.push({ outputSessionId: oid, status }); },
        onMetrics: (_sid, _oid, metrics) => { metricsReceived.push(metrics); },
        onStderrLine: () => {},
        onReconnect: () => {},
      };

      const manager = new FfmpegManager(events);

      try {
        manager.startSession('s1', 'u1', STREAM_KEY, INGEST_IP, [
          { outputSessionId: 'out-1', rtmpUrl: SINK_RTMP_URL, streamKey: 'sink-key-1' },
        ]);

        // Wait for progress metrics
        const deadline = Date.now() + 20_000;
        while (metricsReceived.length === 0 && Date.now() < deadline) {
          await sleep(500);
        }

        expect(metricsReceived.length).toBeGreaterThan(0);
        expect(metricsReceived[0].bitrate).not.toBeNull();
        expect(metricsReceived[0].bitrate!).toBeGreaterThan(0);

        const liveChange = statusChanges.find((s) => s.status === 'live');
        expect(liveChange).toBeDefined();
      } finally {
        await manager.shutdownAll();
      }
    });

    it('stops FFmpeg cleanly and cleans up', async () => {
      testStreamProcess = startTestStream(STREAM_KEY);
      await sleep(3000);

      const statusChanges: Array<{ outputSessionId: string; status: OutputStatus }> = [];
      const events: FfmpegManagerEvents = {
        onStatusChange: (_sid, oid, status) => { statusChanges.push({ outputSessionId: oid, status }); },
        onMetrics: () => {},
        onStderrLine: () => {},
        onReconnect: () => {},
      };

      const manager = new FfmpegManager(events);

      try {
        manager.startSession('s1', 'u1', STREAM_KEY, INGEST_IP, [
          { outputSessionId: 'out-1', rtmpUrl: SINK_RTMP_URL, streamKey: 'sink-key-1' },
        ]);

        // Wait for live
        const deadline = Date.now() + 20_000;
        while (!statusChanges.find((s) => s.status === 'live') && Date.now() < deadline) {
          await sleep(500);
        }

        await manager.stopSession('s1');

        expect(manager.getSession('s1')).toBeUndefined();
        const stoppedChange = statusChanges.find((s) => s.status === 'stopped');
        expect(stoppedChange).toBeDefined();
      } finally {
        await manager.shutdownAll();
      }
    });

    it('classifies connection failure as error after retries', async () => {
      // Stop the ingest container so port 1935 refuses connections
      execSync('docker compose stop ingest', { cwd: workerDir(), stdio: 'ignore', timeout: 15_000 });

      const statusChanges: Array<{ outputSessionId: string; status: OutputStatus }> = [];
      const events: FfmpegManagerEvents = {
        onStatusChange: (_sid, oid, status) => { statusChanges.push({ outputSessionId: oid, status }); },
        onMetrics: () => {},
        onStderrLine: () => {},
        onReconnect: () => {},
      };

      const manager = new FfmpegManager(events);

      try {
        // With ingest stopped, FFmpeg will get "Connection refused" instantly on port 1935
        manager.startSession('s1', 'u1', 'test-key', INGEST_IP, [
          { outputSessionId: 'out-1', rtmpUrl: SINK_RTMP_URL, streamKey: 'nope' },
        ]);

        // Wait for error state — retries: 1+2+4+8+16 = ~31s
        const deadline = Date.now() + 60_000;
        while (!statusChanges.find((s) => s.status === 'error') && Date.now() < deadline) {
          await sleep(1000);
        }

        const retryChanges = statusChanges.filter((s) => s.status === 'retrying');
        expect(retryChanges.length).toBeGreaterThan(0);

        const errorChange = statusChanges.find((s) => s.status === 'error');
        expect(errorChange).toBeDefined();
      } finally {
        await manager.shutdownAll();
        // Restart ingest for subsequent tests
        execSync('docker compose start ingest', { cwd: workerDir(), stdio: 'ignore', timeout: 15_000 });
        await sleep(3000); // Let it come back up
      }
    });
  });
});
