import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LogCapture } from '../log-capture.js';

describe('LogCapture', () => {
  let capture: LogCapture;

  beforeEach(() => {
    capture = new LogCapture();
  });

  afterEach(() => {
    capture.stop();
  });

  describe('captureLine', () => {
    it('buffers lines per outputSessionId', () => {
      capture.captureLine('s1', 'out-1', 'line 1');
      capture.captureLine('s1', 'out-1', 'line 2');

      expect(capture.getBuffer('out-1')).toEqual(['line 1', 'line 2']);
    });

    it('buffers different outputs independently', () => {
      capture.captureLine('s1', 'out-1', 'line a');
      capture.captureLine('s1', 'out-2', 'line b');

      expect(capture.getBuffer('out-1')).toEqual(['line a']);
      expect(capture.getBuffer('out-2')).toEqual(['line b']);
    });

    it('caps buffer at 200 lines', () => {
      for (let i = 0; i < 210; i++) {
        capture.captureLine('s1', 'out-1', `line ${i}`);
      }

      const buf = capture.getBuffer('out-1');
      expect(buf).toHaveLength(200);
      // First 10 lines should have been shifted out
      expect(buf[0]).toBe('line 10');
      expect(buf[199]).toBe('line 209');
    });
  });

  describe('getBuffer', () => {
    it('returns empty array for unknown output', () => {
      expect(capture.getBuffer('unknown')).toEqual([]);
    });
  });

  describe('removeOutput', () => {
    it('clears buffer for an output', () => {
      capture.captureLine('s1', 'out-1', 'line');
      capture.removeOutput('out-1');

      expect(capture.getBuffer('out-1')).toEqual([]);
    });

    it('handles removal of unknown output gracefully', () => {
      expect(() => capture.removeOutput('unknown')).not.toThrow();
    });
  });

  describe('listeners', () => {
    it('notifies listeners on each captureLine call', () => {
      const listener = vi.fn();
      capture.addListener(listener);

      capture.captureLine('s1', 'out-1', 'hello');

      expect(listener).toHaveBeenCalledWith('s1', 'out-1', 'hello');
    });

    it('supports multiple listeners', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      capture.addListener(listener1);
      capture.addListener(listener2);

      capture.captureLine('s1', 'out-1', 'msg');

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it('stops notifying after removeListener', () => {
      const listener = vi.fn();
      capture.addListener(listener);
      capture.removeListener(listener);

      capture.captureLine('s1', 'out-1', 'msg');

      expect(listener).not.toHaveBeenCalled();
    });
  });
});
