import { describe, it, expect, vi } from 'vitest';
import { ProgressParser, type ProgressMetrics } from '../progress-parser.js';

describe('ProgressParser', () => {
  it('emits metrics on progress=continue', () => {
    const onMetrics = vi.fn();
    const parser = new ProgressParser(onMetrics);

    parser.parseLine('bitrate=2500.0kbits/s');
    parser.parseLine('speed=1.00x');
    parser.parseLine('drop_frames=0');
    parser.parseLine('progress=continue');

    expect(onMetrics).toHaveBeenCalledTimes(1);
    expect(onMetrics).toHaveBeenCalledWith({
      bitrate: 2500.0,
      speed: 1.0,
      dropFrames: 0,
    });
  });

  it('emits metrics on progress=end', () => {
    const onMetrics = vi.fn();
    const parser = new ProgressParser(onMetrics);

    parser.parseLine('bitrate=1200.5kbits/s');
    parser.parseLine('progress=end');

    expect(onMetrics).toHaveBeenCalledTimes(1);
    expect(onMetrics.mock.calls[0][0].bitrate).toBe(1200.5);
  });

  it('handles multiple progress blocks', () => {
    const onMetrics = vi.fn();
    const parser = new ProgressParser(onMetrics);

    parser.parseLine('bitrate=1000.0kbits/s');
    parser.parseLine('progress=continue');
    parser.parseLine('bitrate=2000.0kbits/s');
    parser.parseLine('progress=continue');

    expect(onMetrics).toHaveBeenCalledTimes(2);
    expect(onMetrics.mock.calls[0][0].bitrate).toBe(1000.0);
    expect(onMetrics.mock.calls[1][0].bitrate).toBe(2000.0);
  });

  it('returns null for missing fields', () => {
    const onMetrics = vi.fn();
    const parser = new ProgressParser(onMetrics);

    parser.parseLine('progress=continue');

    expect(onMetrics).toHaveBeenCalledWith({
      bitrate: null,
      speed: null,
      dropFrames: null,
    });
  });

  it('handles kbit/s format (without trailing s)', () => {
    const onMetrics = vi.fn();
    const parser = new ProgressParser(onMetrics);

    parser.parseLine('bitrate=500.0kbit/s');
    parser.parseLine('progress=continue');

    expect(onMetrics.mock.calls[0][0].bitrate).toBe(500.0);
  });

  it('ignores empty and malformed lines', () => {
    const onMetrics = vi.fn();
    const parser = new ProgressParser(onMetrics);

    parser.parseLine('');
    parser.parseLine('  ');
    parser.parseLine('no-equals-sign');
    parser.parseLine('bitrate=1000.0kbits/s');
    parser.parseLine('progress=continue');

    expect(onMetrics).toHaveBeenCalledTimes(1);
  });
});
