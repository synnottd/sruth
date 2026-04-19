const LOG_MAX_LINES = 200;

/**
 * Default delay before evicting the stderr buffer of an output that has
 * entered a terminal 'error' state without a follow-up stop command.
 * Short-term memory hygiene; long-term persistence tracked in #58.
 */
export const ERROR_EVICTION_DELAY_MS = 10 * 60 * 1000; // 10 minutes

export type LogListener = (sessionId: string, outputSessionId: string, line: string) => void;

export class LogCapture {
  private buffers: Map<string, string[]> = new Map(); // keyed by outputSessionId
  private listeners: Set<LogListener> = new Set();
  private evictionTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  start(): void {
    console.log('[LogCapture] Started');
  }

  stop(): void {
    for (const timer of this.evictionTimers.values()) {
      clearTimeout(timer);
    }
    this.evictionTimers.clear();
    this.buffers.clear();
    this.listeners.clear();
    console.log('[LogCapture] Stopped');
  }

  addListener(listener: LogListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: LogListener): void {
    this.listeners.delete(listener);
  }

  /** Called for each FFmpeg stderr line. */
  captureLine(sessionId: string, outputSessionId: string, line: string): void {
    // Buffer for SSE snapshot
    let buf = this.buffers.get(outputSessionId);
    if (!buf) {
      buf = [];
      this.buffers.set(outputSessionId, buf);
    }
    buf.push(line);
    if (buf.length > LOG_MAX_LINES) {
      buf.shift();
    }

    // Notify listeners (SSE)
    for (const listener of this.listeners) {
      listener(sessionId, outputSessionId, line);
    }
  }

  /** Get buffered lines for SSE snapshot on connect. */
  getBuffer(outputSessionId: string): string[] {
    return this.buffers.get(outputSessionId) ?? [];
  }

  /**
   * Schedule buffer eviction after `delayMs`. Replaces any existing timer for
   * this output. Used for outputs that transition to a terminal 'error'
   * without a follow-up stop command, so their buffers don't linger forever.
   */
  scheduleEviction(outputSessionId: string, delayMs: number = ERROR_EVICTION_DELAY_MS): void {
    this.cancelEviction(outputSessionId);
    const timer = setTimeout(() => {
      this.buffers.delete(outputSessionId);
      this.evictionTimers.delete(outputSessionId);
    }, delayMs);
    this.evictionTimers.set(outputSessionId, timer);
  }

  /** Cancel a pending eviction (e.g. output resurrected, or stop arrived). */
  cancelEviction(outputSessionId: string): void {
    const timer = this.evictionTimers.get(outputSessionId);
    if (timer) {
      clearTimeout(timer);
      this.evictionTimers.delete(outputSessionId);
    }
  }

  /** Remove buffer and cancel any pending eviction (stop path). */
  removeOutput(outputSessionId: string): void {
    this.cancelEviction(outputSessionId);
    this.buffers.delete(outputSessionId);
  }
}
