import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { OutputTarget } from '@omega-stream/shared';
import { classifyError, type ErrorClass } from './error-classifier.js';
import { ProgressParser, type ProgressMetrics } from './progress-parser.js';

const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1000; // 1s, 2s, 4s, 8s, 16s
const INGEST_PORT = 1935;
const INGEST_APP = 'live';

/** Redact stream keys from RTMP URLs for safe logging. */
function redactStreamKey(url: string): string {
  // Match rtmp://host/app/STREAM_KEY — redact the key portion
  return url.replace(/(rtmp:\/\/[^/]+\/[^/]+\/)(.+)/, '$1***');
}

export type OutputStatus = 'starting' | 'live' | 'retrying' | 'error' | 'stopped';

export interface OutputProcess {
  outputSessionId: string;
  rtmpUrl: string;
  streamKey: string;
  process: ChildProcess | null;
  abortController: AbortController;
  retryCount: number;
  status: OutputStatus;
  lastError: string | null;
  lastMetrics: ProgressMetrics | null;
  stderrBuffer: string[];
}

export interface Session {
  sessionId: string;
  userId: string;
  streamKey: string;
  ingestIp: string;
  outputs: Map<string, OutputProcess>;
}

export interface FfmpegManagerEvents {
  onStatusChange: (sessionId: string, outputSessionId: string, status: OutputStatus, error: string | null) => void;
  onMetrics: (sessionId: string, outputSessionId: string, metrics: ProgressMetrics) => void;
  onStderrLine: (sessionId: string, outputSessionId: string, line: string) => void;
}

export class FfmpegManager {
  private sessions: Map<string, Session> = new Map();
  private events: FfmpegManagerEvents;

  constructor(events: FfmpegManagerEvents) {
    this.events = events;
  }

  /** Start a new session with all its outputs. */
  startSession(
    sessionId: string,
    userId: string,
    streamKey: string,
    ingestIp: string,
    outputs: OutputTarget[],
  ): void {
    if (this.sessions.has(sessionId)) {
      console.warn('[FFmpeg] Session already exists:', sessionId);
      return;
    }

    const session: Session = {
      sessionId,
      userId,
      streamKey,
      ingestIp,
      outputs: new Map(),
    };
    this.sessions.set(sessionId, session);

    for (const output of outputs) {
      this.addOutput(session, output);
    }
  }

  /** Stop an entire session or a single output. */
  async stopSession(sessionId: string, outputSessionId?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (outputSessionId) {
      const output = session.outputs.get(outputSessionId);
      if (output) {
        await this.killOutput(output);
        session.outputs.delete(outputSessionId);
        this.events.onStatusChange(sessionId, outputSessionId, 'stopped', null);
      }
      // If no outputs remain, clean up the session
      if (session.outputs.size === 0) {
        this.sessions.delete(sessionId);
      }
      return;
    }

    // Stop all outputs
    const kills = Array.from(session.outputs.values()).map((output) =>
      this.killOutput(output),
    );
    await Promise.all(kills);
    for (const outputSessionId of session.outputs.keys()) {
      this.events.onStatusChange(sessionId, outputSessionId, 'stopped', null);
    }
    this.sessions.delete(sessionId);
  }

  /** Add outputs to an existing session. */
  async addOutputs(sessionId: string, outputs: OutputTarget[]): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn('[FFmpeg] Cannot add outputs — session not found:', sessionId);
      return;
    }
    for (const target of outputs) {
      // Kill existing output with the same ID to prevent orphaned processes
      const existing = session.outputs.get(target.outputSessionId);
      if (existing) {
        console.warn('[FFmpeg] Replacing existing output:', target.outputSessionId);
        await this.killOutput(existing);
      }
      this.addOutput(session, target);
    }
  }

  /** Remove specific outputs from a session. */
  async removeOutputs(sessionId: string, outputSessionIds: string[]): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (const id of outputSessionIds) {
      const output = session.outputs.get(id);
      if (output) {
        await this.killOutput(output);
        session.outputs.delete(id);
        this.events.onStatusChange(sessionId, id, 'stopped', null);
      }
    }
  }

  /** Handle ingest IP change — abort all retries, update IP, restart all outputs. */
  async relocateIngest(sessionId: string, newIngestIp: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn('[FFmpeg] Cannot relocate — session not found:', sessionId);
      return;
    }

    console.log('[FFmpeg] Relocating session', sessionId, 'to', newIngestIp);

    // Abort all in-progress retries and kill processes
    for (const output of session.outputs.values()) {
      output.abortController.abort();
      await this.killProcess(output);
    }

    // Update ingest IP and restart all outputs
    session.ingestIp = newIngestIp;
    for (const output of session.outputs.values()) {
      output.abortController = new AbortController();
      output.retryCount = 0;
      output.status = 'starting';
      this.spawnWithRetry(session, output);
    }
  }

  /** Gracefully shut down all sessions. */
  async shutdownAll(): Promise<void> {
    const kills: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      for (const output of session.outputs.values()) {
        output.abortController.abort();
        kills.push(this.killOutput(output));
      }
    }
    await Promise.all(kills);
    this.sessions.clear();
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getSessions(): Map<string, Session> {
    return this.sessions;
  }

  // --- Private ---

  private addOutput(session: Session, target: OutputTarget): void {
    const output: OutputProcess = {
      outputSessionId: target.outputSessionId,
      rtmpUrl: target.rtmpUrl,
      streamKey: target.streamKey,
      process: null,
      abortController: new AbortController(),
      retryCount: 0,
      status: 'starting',
      lastError: null,
      lastMetrics: null,
      stderrBuffer: [],
    };
    session.outputs.set(target.outputSessionId, output);
    this.events.onStatusChange(session.sessionId, target.outputSessionId, 'starting', null);
    this.spawnWithRetry(session, output);
  }

  private spawnWithRetry(session: Session, output: OutputProcess): void {
    const { stderrDone } = this.spawnFfmpeg(session, output);

    output.process!.on('close', (code) => {
      // If we were stopped intentionally or abort was signaled, don't retry
      if (output.status === 'stopped' || output.abortController.signal.aborted) {
        return;
      }

      // Wait for stderr readline to finish so stderrBuffer is fully populated
      stderrDone.then(() => {
        this.handleProcessExit(session, output, code ?? 1);
      });
    });
  }

  private handleProcessExit(session: Session, output: OutputProcess, code: number): void {
    if (output.status === 'stopped' || output.abortController.signal.aborted) {
      return;
    }

    // Clean exit (code 0) means the source stream ended — don't retry
    if (code === 0) {
      console.log('[FFmpeg] Output', output.outputSessionId, 'exited cleanly (source stream ended)');
      output.status = 'stopped';
      this.events.onStatusChange(session.sessionId, output.outputSessionId, 'stopped', null);
      return;
    }

    const stderrText = output.stderrBuffer.join('\n');
    const errorClass = classifyError(stderrText);

    console.log(
      '[FFmpeg] Output', output.outputSessionId, 'exited code', code,
      'class:', errorClass, 'retries:', output.retryCount,
    );

    if (errorClass === 'user') {
      output.status = 'error';
      output.lastError = stderrText.slice(-500);
      this.events.onStatusChange(session.sessionId, output.outputSessionId, 'error', output.lastError);
      return;
    }

    if (errorClass === 'transient' && output.retryCount < MAX_RETRIES) {
      output.status = 'retrying';
      this.events.onStatusChange(session.sessionId, output.outputSessionId, 'retrying', null);
      this.retryAfterBackoff(session, output);
      return;
    }

    // Fatal or retries exhausted
    output.status = 'error';
    output.lastError = stderrText.slice(-500) || `FFmpeg exited with code ${code}`;
    this.events.onStatusChange(session.sessionId, output.outputSessionId, 'error', output.lastError);
  }

  private spawnFfmpeg(session: Session, output: OutputProcess): { stderrDone: Promise<void> } {
    const inputUrl = `rtmp://${session.ingestIp}:${INGEST_PORT}/${INGEST_APP}/${session.streamKey}`;
    const outputUrl = `${output.rtmpUrl}/${output.streamKey}`;

    const args = [
      '-hide_banner',
      '-i', inputUrl,
      '-c', 'copy',
      '-f', 'flv',
      '-progress', 'pipe:1',
      outputUrl,
    ];

    console.log('[FFmpeg] Spawning for', output.outputSessionId, '→', redactStreamKey(output.rtmpUrl));

    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    output.process = proc;
    output.stderrBuffer = [];

    // Handle spawn errors (e.g. ENOENT if ffmpeg binary is missing)
    proc.on('error', (err) => {
      console.error('[FFmpeg] Process error for', output.outputSessionId, err.message);
      output.stderrBuffer.push(err.message);
    });

    // Parse stdout for -progress metrics
    const progressParser = new ProgressParser((metrics) => {
      output.lastMetrics = metrics;
      // First metrics received means we're live
      if (output.status === 'starting' || output.status === 'retrying') {
        output.status = 'live';
        output.retryCount = 0; // Reset on successful connection
        this.events.onStatusChange(session.sessionId, output.outputSessionId, 'live', null);
      }
      this.events.onMetrics(session.sessionId, output.outputSessionId, metrics);
    });

    const stdoutRl = createInterface({ input: proc.stdout! });
    stdoutRl.on('line', (line) => progressParser.parseLine(line));

    // Capture stderr line-by-line
    const stderrRl = createInterface({ input: proc.stderr! });
    stderrRl.on('line', (line) => {
      output.stderrBuffer.push(line);
      // Cap buffer to last 200 lines
      if (output.stderrBuffer.length > 200) {
        output.stderrBuffer.shift();
      }
      this.events.onStderrLine(session.sessionId, output.outputSessionId, line);
    });

    // Promise that resolves when stderr readline is done (all lines parsed)
    const stderrDone = new Promise<void>((resolve) => {
      stderrRl.on('close', resolve);
    });

    return { stderrDone };
  }

  private async retryAfterBackoff(session: Session, output: OutputProcess): Promise<void> {
    const delay = BACKOFF_BASE_MS * Math.pow(2, output.retryCount);
    output.retryCount++;

    console.log('[FFmpeg] Retry', output.retryCount, 'for', output.outputSessionId, 'in', delay, 'ms');

    try {
      await cancellableSleep(delay, output.abortController.signal);
    } catch {
      // Aborted (e.g. ingest_relocated or shutdown)
      return;
    }

    // Double-check we weren't stopped during sleep and session still exists
    if (output.status === 'stopped' || output.abortController.signal.aborted) {
      return;
    }
    if (!this.sessions.has(session.sessionId)) {
      return;
    }

    this.spawnWithRetry(session, output);
  }

  private async killOutput(output: OutputProcess): Promise<void> {
    output.status = 'stopped';
    output.abortController.abort();
    await this.killProcess(output);
  }

  private async killProcess(output: OutputProcess): Promise<void> {
    const proc = output.process;
    if (!proc || proc.exitCode !== null) {
      output.process = null;
      return;
    }

    return new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 5000);

      proc.once('close', () => {
        clearTimeout(killTimer);
        output.process = null;
        resolve();
      });

      proc.kill('SIGTERM');
    });
  }
}

function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
