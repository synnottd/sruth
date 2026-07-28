import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAdmin } from '../src/plugins/auth.js';

/**
 * Admin auth is env-driven: ADMIN_EMAILS is a comma-separated list. We want
 * generous parsing (trim, lowercase, skip empties) so a stray space or
 * trailing comma in the .env file doesn't silently lock an admin out.
 */
describe('isAdmin', () => {
  const originalEnv = process.env.ADMIN_EMAILS;

  beforeEach(() => {
    delete process.env.ADMIN_EMAILS;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalEnv;
  });

  it('returns false when ADMIN_EMAILS is unset', () => {
    expect(isAdmin('anyone@example.com')).toBe(false);
  });

  it('matches a single configured email', () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    expect(isAdmin('admin@example.com')).toBe(true);
    expect(isAdmin('other@example.com')).toBe(false);
  });

  it('matches any email in a comma-separated list', () => {
    process.env.ADMIN_EMAILS = 'alice@example.com,bob@example.com';
    expect(isAdmin('alice@example.com')).toBe(true);
    expect(isAdmin('bob@example.com')).toBe(true);
    expect(isAdmin('carol@example.com')).toBe(false);
  });

  it('is case-insensitive and tolerates whitespace around entries', () => {
    process.env.ADMIN_EMAILS = ' Alice@Example.com , BOB@example.com ';
    expect(isAdmin('alice@example.com')).toBe(true);
    expect(isAdmin('ALICE@example.com')).toBe(true);
    expect(isAdmin('bob@example.com')).toBe(true);
  });

  it('skips empty entries caused by trailing or double commas', () => {
    process.env.ADMIN_EMAILS = 'admin@example.com,,';
    // Empty string must never be admin, even if a trailing comma produces one.
    expect(isAdmin('')).toBe(false);
    expect(isAdmin('admin@example.com')).toBe(true);
  });
});
