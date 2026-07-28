import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import authPlugin from '../src/plugins/auth.js';

/**
 * `authenticateAdmin` composes `authenticate` (JWT verify → 401) with an
 * ADMIN_EMAILS allowlist check (→ 403). These tests stand up a throwaway
 * Fastify app with a single protected route so the decorator is exercised
 * end-to-end via HTTP, without dragging in the rest of buildApp().
 */

const originalAdminEmails = process.env.ADMIN_EMAILS;
const originalJwtSecret = process.env.JWT_SECRET;

describe('authenticateAdmin', () => {
  let app: FastifyInstance;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-for-admin-decorator';
  });

  beforeEach(async () => {
    // Rebuild the app for each test so env changes are visible. ADMIN_EMAILS
    // is read on each isAdmin() call, but the JWT secret is captured at
    // plugin register time, so a fresh instance is safest.
    if (app) await app.close();
    app = Fastify();
    await app.register(authPlugin);
    app.get('/protected', { onRequest: [app.authenticateAdmin] }, async () => ({
      ok: true,
    }));
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalAdminEmails;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  it('rejects requests without a token as 401', async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a valid JWT whose email is not in ADMIN_EMAILS as 403', async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const token = app.jwt.sign({ sub: 'u-1', email: 'not-admin@example.com' });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('FORBIDDEN');
  });

  it('allows a valid JWT whose email is in ADMIN_EMAILS', async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const token = app.jwt.sign({ sub: 'u-1', email: 'admin@example.com' });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('rejects even an admin email as 403 when ADMIN_EMAILS is unset', async () => {
    // Defence in depth: even if someone signs a JWT for an email that *would*
    // be admin elsewhere, an unset ADMIN_EMAILS must refuse entry.
    delete process.env.ADMIN_EMAILS;
    const token = app.jwt.sign({ sub: 'u-1', email: 'admin@example.com' });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
