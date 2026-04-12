export type ErrorClass = 'user' | 'transient' | 'fatal';

const USER_ERROR_PATTERNS = [
  /Authorization failed/i,
  /Authentication/i,
  /\b401\b/,
  /\b403\b/,
  /Stream not found/i,
  /Invalid stream key/i,
];

const TRANSIENT_ERROR_PATTERNS = [
  /Connection refused/i,
  /Connection timed out/i,
  /Operation timed out/i,
  /Connection reset/i,
  /Broken pipe/i,
  /No route to host/i,
  /Network is unreachable/i,
  /End of file/i,
  /Input\/output error/i,
];

/**
 * Classify FFmpeg stderr output to determine retry behavior.
 * - user: surfaced in UI, no retry (bad credentials, etc.)
 * - transient: auto-retry with backoff (network blips)
 * - fatal: no retry, mark error
 */
export function classifyError(stderr: string): ErrorClass {
  for (const pattern of USER_ERROR_PATTERNS) {
    if (pattern.test(stderr)) return 'user';
  }
  for (const pattern of TRANSIENT_ERROR_PATTERNS) {
    if (pattern.test(stderr)) return 'transient';
  }
  return 'fatal';
}
