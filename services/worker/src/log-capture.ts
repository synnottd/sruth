const LOG_MAX_LINES = 200;

export type LogListener = (sessionId: string, outputSessionId: string, line: string) => void;

export class LogCapture {
  private buffers: Map<string, string[]> = new Map(); // keyed by outputSessionId
  private listeners: Set<LogListener> = new Set();

  start(): void {
    console.log('[LogCapture] Started');
  }

  stop(): void {
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

  /** Remove buffers for a stopped output. */
  removeOutput(outputSessionId: string): void {
    this.buffers.delete(outputSessionId);
  }
}
