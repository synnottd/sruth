/**
 * Parsed metrics from FFmpeg's `-progress pipe:1` output.
 */
export interface ProgressMetrics {
  bitrate: number | null;    // kbits/s
  speed: number | null;      // e.g. 1.0 = realtime
  dropFrames: number | null;
}

/**
 * Accumulates key=value lines from FFmpeg -progress stdout output.
 * Emits a ProgressMetrics snapshot on each `progress=continue` marker.
 */
export class ProgressParser {
  private pending: Map<string, string> = new Map();
  private onMetrics: (metrics: ProgressMetrics) => void;

  constructor(onMetrics: (metrics: ProgressMetrics) => void) {
    this.onMetrics = onMetrics;
  }

  parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    const eq = trimmed.indexOf('=');
    if (eq === -1) return;

    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);

    if (key === 'progress') {
      if (value === 'continue' || value === 'end') {
        this.flush();
      }
      return;
    }

    this.pending.set(key, value);
  }

  private flush(): void {
    const metrics: ProgressMetrics = {
      bitrate: parseBitrate(this.pending.get('bitrate')),
      speed: parseSpeed(this.pending.get('speed')),
      dropFrames: parseInteger(this.pending.get('drop_frames')),
    };
    this.pending.clear();
    this.onMetrics(metrics);
  }
}

/** Parse "1234.5kbits/s" or "  70.3kbits/s" → number (kbits/s) */
function parseBitrate(val: string | undefined): number | null {
  if (!val) return null;
  const match = val.trim().match(/^([\d.]+)kbits?\/s$/);
  return match ? parseFloat(match[1]) : null;
}

/** Parse "1.00x" or " 1.00x" → number */
function parseSpeed(val: string | undefined): number | null {
  if (!val) return null;
  const match = val.trim().match(/^([\d.]+)x$/);
  return match ? parseFloat(match[1]) : null;
}

function parseInteger(val: string | undefined): number | null {
  if (!val) return null;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? null : n;
}
