import { describe, it, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter, PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { ProgressMetrics } from '../progress-parser.js';

// Create a fake child process with PassThrough streams for stdout/stderr
function createFakeProcess(): ChildProcess & { _close: (code: number) => void } {
  const proc = new EventEmitter() as ChildProcess & {
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    _close: (code: number) => void;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.exitCode = null;
  proc.pid = 12345;

  proc.kill = vi.fn(() => {
    // Immediate close on kill for test simplicity
    proc._close(0);
    return true;
  });

  proc._close = (code: number) => {
    if (proc.exitCode !== null) return; // Already closed
    proc.exitCode = code;
    proc.stdout.end();
    proc.stderr.end();
    proc.emit('close', code);
  };

  return proc;
}

const fakeProcesses: Array<ChildProcess & { _close: (code: number) => void }> = [];
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const proc = createFakeProcess();
    fakeProcesses.push(proc);
    return proc;
  }),
}));

import { FfmpegManager, redactStreamKey, type FfmpegManagerEvents, type OutputStatus } from '../ffmpeg-manager.js';

const testOutput = {
  outputSessionId: 'out-1',
  rtmpUrl: 'rtmp://live.twitch.tv/app',
  streamKey: 'live_xxx',
};

const testOutput2 = {
  outputSessionId: 'out-2',
  rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
  streamKey: 'yt_yyy',
};

describe('FfmpegManager', () => {
  let manager: FfmpegManager;
  let statusChanges: Array<{ sessionId: string; outputSessionId: string; status: OutputStatus; error: string | null }>;
  let metricsReceived: Array<{ sessionId: string; outputSessionId: string; metrics: ProgressMetrics }>;
  let stderrLines: Array<{ sessionId: string; outputSessionId: string; line: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeProcesses.length = 0;
    statusChanges = [];
    metricsReceived = [];
    stderrLines = [];

    const events: FfmpegManagerEvents = {
      onStatusChange: (sessionId, outputSessionId, status, error) => {
        statusChanges.push({ sessionId, outputSessionId, status, error });
      },
      onMetrics: (sessionId, outputSessionId, metrics) => {
        metricsReceived.push({ sessionId, outputSessionId, metrics });
      },
      onStderrLine: (sessionId, outputSessionId, line) => {
        stderrLines.push({ sessionId, outputSessionId, line });
      },
      onReconnect: () => {},
    };

    manager = new FfmpegManager(events);
  });

  afterEach(async () => {
    // Shut down manager properly — sets all outputs to 'stopped' before killing
    await manager.shutdownAll();
    // Close any orphaned processes
    for (const proc of fakeProcesses) {
      if (proc.exitCode === null) proc._close(0);
    }
    vi.useRealTimers();
  });

  describe('startSession', () => {
    it('spawns FFmpeg process for each output', () => {
      manager.startSession('s1', 'u1', 'key1', '10.0.1.1', [testOutput, testOutput2]);

      expect(fakeProcesses).toHaveLength(2);
      const session = manager.getSession('s1');
      expect(session).toBeDefined();
      expect(session!.outputs.size).toBe(2);
    });

    it('emits starting status for each output', () => {
      manager.startSession('s1', 'u1', 'key1', '10.0.1.1', [testOutput]);

      expect(statusChanges).toEqual([
        { sessionId: 's1', outputSessionId: 'out-1', status: 'starting', error: null },
      ]);
    });

    it('is idempotent — diffs outputs on duplicate session start', () => {
      manager.startSession('s1', 'u1', 'key1', '10.0.1.1', [testOutput]);
      manager.startSession('s1', 'u1', 'key1', '10.0.1.1', [testOutput, testOutput2]);

      // Should have spawned out-1 initially, then added out-2 on second call
      expect(fakeProcesses).toHaveLength(2);
      const session = manager.getSession('s1');
      expect(session!.outputs.size).toBe(2);
    });
  });

  describe('progress parsing', () => {
    it('transitions to live on first metrics and emits them', async () => {
      manager.startSession('s1', 'u1', 'key1', '10.0.1.1', [testOutput]);
      const proc = fakeProcesses[0];

      proc.stdout.write('bitrate=2500.0kbits/s\nspeed=1.00x\ndrop_frames=0\nprogress=continue\n');

      // Let readline process the lines
      await vi.advanceTimersByTimeAsync(10);

      expect(metricsReceived).toHaveLength(1);
      expect(metricsReceived[0].metrics.bitrate).toBe(2500.0);

      const liveChange = statusChanges.find((s) => s.status === 'live');
      expect(liveChange).toBeDefined();
    });
  });

  describe('stderr capture', () => {
    it('captures stderr lines and emits them', async () => {
      manager.startSession('s1', 'u1', 'key1', '10.0.1.1', [testOutput]);
      const proc = fakeProcesses[0];

      proc.stderr.write('Some FFmpeg info message\n');

      await vi.advanceTimersByTimeAsync(10);

      expect(stderrLines).toHaveLength(1);
      expect(stderrLines[0].line).toBe('Some FFmpeg info message');
    });
  });

  describe('stopSession', () => {
    it('kills all outputs for a session', async () => {
      manager.startSession('s1', 'u1', 'key1', '10.0.1.1', [testOutput, testOutput2]);
      statusChanges = [];

      await manager.stopSession('s1');

      expect(manager.getSession('s1')).toBeUndefined();
      expect(statusChanges).toHaveLength(2);
      expect(statusChanges.every((s) => s.status === 'stopped')).toBe(true);
    });

    it('kills a single output when outputSessionId provided', async () => {
      manager.startSession('s1', 'u1', 'key1', '10.0.1.1', [testOutput, testOutput2]);
      statusChanges = [];

      await manager.stopSession('s1', 'out-1');

      const session = manager.getSession('s1');
      expect(session).toBeDefined();
      expect(session!.outputs.size).toBe(1);
      expect(session!.outputs.has('out-2')).toBe(true);
    });

    it('cleans up session when last output is stopped', async () => {
      manager.startSession('s1', 'u1', 'key1', '10.0.1.1', [testOutput]);

      await manager.stopSession('s1', 'out-1');

      expect(manager.getSession('s1')).toBeUndefined();
    });
  });

  describe('retry on transient error', () => {
    it('retries with exponential backoff on transient exit', async () => {
      manager.startSession('s1', 'u1', 'key1', '10.0.1.1', [testOutput]);
      const proc = fakeProcesses[0];

      // Write transient error to stderr then close
      proc.stderr.write('Connection refused\n');
      await vi.advanceTimersByTimeAsync(10);
      proc._close(1);
      // Let stderrDone promise + handleProcessExit resolve
      await vi.advanceTimersByTimeAsync(10);

      const retryChange = statusChanges.find((s) => s.status === 'retrying');
      expect(retryChange).toBeDefined();

      // Advance past first backoff (2s)
      await vi.advanceTimersByTimeAsync(2100);

      // Should have spawned a second process
      expect(fakeProcesses).toHaveLength(2);
    });

    it('marks error after max retries exhausted', async () => {
      manager.startSession('s1', 'u1', 'key1', '10.0.1.1', [testOutput]);

      // MAX_RETRIES is 8, BACKOFF_BASE_MS is 2000
      for (let i = 0; i <= 8; i++) {
        const proc = fakeProcesses[i];
        proc.stderr.write('Connection refused\n');
        await vi.advanceTimersByTimeAsync(10);
        proc._close(1);
        await vi.advanceTimersByTimeAsync(10);

        if (i < 8) {
          const delay = 2000 * Math.pow(2, i);
          await vi.advanceTimersByTimeAsync(delay + 100);
        }
      }

      const errorChanges = statusChanges.filter((s) => s.status === 'error');
      expect(errorChanges).toHaveLength(1);
    });
  });

  describe('clean exit (code 0) — no retry', () => {
    it('marks stopped on clean exit without retrying', async () => {
      manager.startSession('s1', 'u1', 'key1', '10.0.1.1', [testOutput]);
      const proc = fakeProcesses[0];

      proc._close(0);
      await vi.advanceTimersByTimeAsync(10);

      const stoppedChange = statusChanges.find((s) => s.status === 'stopped');
      expect(stoppedChange).toBeDefined();

      // Should NOT retry
      await vi.advanceTimersByTimeAsync(5000);
      expect(fakeProcesses).toHaveLength(1);
    });
  });

  describe('user error — no retry', () => {
    it('marks error immediately on user error', async () => {
      manager.startSession('s1', 'u1', 'key1', '10.0.1.1', [testOutput]);
      const proc = fakeProcesses[0];

      proc.stderr.write('Authorization failed\n');
      await vi.advanceTimersByTimeAsync(10);
      proc._close(1);
      await vi.advanceTimersByTimeAsync(10);

      const errorChange = statusChanges.find((s) => s.status === 'error');
      expect(errorChange).toBeDefined();
      expect(errorChange!.error).toContain('Authorization failed');

      // No retry
      await vi.advanceTimersByTimeAsync(5000);
      expect(fakeProcesses).toHaveLength(1);
    });
  });

  describe('spawn error handling', () => {
    it('handles process error event (e.g. ENOENT)', async () => {
      manager.startSession('s1', 'u1', 'key1', '10.0.1.1', [testOutput]);
      const proc = fakeProcesses[0];

      // Simulate ENOENT error from spawn
      proc.emit('error', new Error('spawn ffmpeg ENOENT'));
      await vi.advanceTimersByTimeAsync(10);

      // Error should be captured in stderr buffer
      const session = manager.getSession('s1');
      const output = session!.outputs.get('out-1')!;
      expect(output.stderrBuffer).toContain('spawn ffmpeg ENOENT');
    });

    it('classifies spawn error as fatal after process close', async () => {
      manager.startSession('s1', 'u1', 'key1', '10.0.1.1', [testOutput]);
      const proc = fakeProcesses[0];

      proc.emit('error', new Error('spawn ffmpeg ENOENT'));
      proc._close(1);
      await vi.advanceTimersByTimeAsync(10);

      const errorChange = statusChanges.find((s) => s.status === 'error');
      expect(errorChange).toBeDefined();

      // Should NOT retry — fatal error
      await vi.advanceTimersByTimeAsync(5000);
      expect(fakeProcesses).toHaveLength(1);
    });
  });

  describe('addOutputs', () => {
    it('adds new outputs to existing session', async () => {
      manager.startSession('s1', 'u1', 'key1', '10.0.1.1', [testOutput]);
      await manager.addOutputs('s1', [testOutput2]);

      const session = manager.getSession('s1');
      expect(session!.outputs.size).toBe(2);
      expect(fakeProcesses).toHaveLength(2);
    });

    it('kills existing output when adding duplicate outputSessionId', async () => {
      manager.startSession('s1', 'u1', 'key1', '10.0.1.1', [testOutput]);
      expect(fakeProcesses).toHaveLength(1);

      const originalProc = fakeProcesses[0];
      await manager.addOutputs('s1', [testOutput]);

      // Old process should be killed, new one spawned
      expect(originalProc.kill).toHaveBeenCalled();
      expect(fakeProcesses).toHaveLength(2);

      const session = manager.getSession('s1');
      expect(session!.outputs.size).toBe(1);
    });
  });

  describe('removeOutputs', () => {
    it('stops specific outputs without affecting others', async () => {
      manager.startSession('s1', 'u1', 'key1', '10.0.1.1', [testOutput, testOutput2]);

      await manager.removeOutputs('s1', ['out-1']);

      const session = manager.getSession('s1');
      expect(session!.outputs.size).toBe(1);
      expect(session!.outputs.has('out-2')).toBe(true);
    });
  });
});

describe('redactStreamKey', () => {
  // Add new protocols/shapes here as we support them.
  test.each([
    { name: 'rtmp with path key', input: 'rtmp://live.twitch.tv/app/SECRETKEY', expected: 'rtmp://live.twitch.tv/app/***' },
    { name: 'rtmps with path key', input: 'rtmps://live-api-s.facebook.com:443/rtmp/SECRETKEY', expected: 'rtmps://live-api-s.facebook.com:443/rtmp/***' },
    { name: 'srt with streamid query', input: 'srt://srt.example.com:10000?streamid=SECRETKEY', expected: 'srt://srt.example.com:10000?streamid=***' },
  ])('redacts $name', ({ input, expected }) => {
    expect(redactStreamKey(input)).toBe(expected);
  });

  it('returns [unparseable url] for invalid input', () => {
    expect(redactStreamKey('not a url')).toBe('[unparseable url]');
  });

  it('leaves base URLs without a key segment unchanged', () => {
    expect(redactStreamKey('rtmp://live.twitch.tv/app')).toBe('rtmp://live.twitch.tv/app');
  });
});
