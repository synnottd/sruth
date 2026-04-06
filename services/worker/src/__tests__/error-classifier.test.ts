import { describe, it, expect } from 'vitest';
import { classifyError } from '../error-classifier.js';

describe('classifyError', () => {
  describe('user errors', () => {
    it('detects authorization failures', () => {
      expect(classifyError('Authorization failed for stream key')).toBe('user');
    });

    it('detects authentication errors', () => {
      expect(classifyError('RTMP Authentication failure')).toBe('user');
    });

    it('detects 403 responses', () => {
      expect(classifyError('Server returned 403 Forbidden')).toBe('user');
    });
  });

  describe('transient errors', () => {
    it('detects connection refused', () => {
      expect(classifyError('Connection refused')).toBe('transient');
    });

    it('detects connection timed out', () => {
      expect(classifyError('Connection timed out')).toBe('transient');
    });

    it('detects connection reset', () => {
      expect(classifyError('Connection reset by peer')).toBe('transient');
    });

    it('detects broken pipe', () => {
      expect(classifyError('Broken pipe')).toBe('transient');
    });

    it('detects end of file', () => {
      expect(classifyError('End of file reached')).toBe('transient');
    });
  });

  describe('fatal errors', () => {
    it('classifies unknown errors as fatal', () => {
      expect(classifyError('Something completely unknown')).toBe('fatal');
    });

    it('classifies empty stderr as fatal', () => {
      expect(classifyError('')).toBe('fatal');
    });
  });
});
