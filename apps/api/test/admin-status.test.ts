import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { getApp, closeApp, registerUser } from './helper.js';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * End-to-end tests for the /admin/status/snapshot and /admin/status/stream
 * routes. These exercise auth gating, the three-way composition (queue /
 * sessions / MediaMTX), and the publisher↔user email join. MediaMTX HTTP is
 * mocked by stubbing globalThis.fetch.
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ADMIN_EMAILS = process.env.ADMIN_EMAILS;

const ADMIN_EMAIL = 'admin-dash@example.com';

afterAll(async () => {
  await closeApp();
  await prisma.$disconnect();
});

beforeEach(() => {
  // Point MediaMTX at a stub. Overridden per test as needed.
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    async json() {
      return { items: [] };
    },
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_ADMIN_EMAILS === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = ORIGINAL_ADMIN_EMAILS;
  vi.restoreAllMocks();
});

describe('GET /admin/status/snapshot — auth', () => {
  it('returns 401 without an access token', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/admin/status/snapshot' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for a valid JWT whose email is not an admin', async () => {
    delete process.env.ADMIN_EMAILS;
    const { accessToken } = await registerUser({ email: 'not-an-admin@example.com' });
    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/status/snapshot',
      cookies: { accessToken },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 200 for an admin', async () => {
    const { accessToken } = await registerUser({ email: ADMIN_EMAIL, admin: true });
    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/status/snapshot',
      cookies: { accessToken },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /admin/status/snapshot — shape', () => {
  it('returns the full snapshot envelope with generatedAt and empty collections when the DB is empty', async () => {
    const { accessToken } = await registerUser({ email: ADMIN_EMAIL, admin: true });
    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/status/snapshot',
      cookies: { accessToken },
    });
    const body = JSON.parse(res.body);

    expect(body.generatedAt).toBeTypeOf('string');
    expect(new Date(body.generatedAt).toString()).not.toBe('Invalid Date');
    expect(body.queue).toEqual({
      pending: 0,
      claimed: 0,
      failed: 0,
      oldestPendingAgeMs: null,
      recentFailures: [],
    });
    expect(body.sessions).toEqual([]);
    expect(body.mediamtx).toEqual({
      reachable: true,
      publishers: [],
      byProtocol: { rtmp: 0, srt: 0 },
    });
  });

  it('counts queue rows by status and reports oldestPendingAgeMs', async () => {
    const { accessToken } = await registerUser({ email: ADMIN_EMAIL, admin: true });

    const now = Date.now();
    const oldPendingCreatedAt = new Date(now - 30_000);
    await prisma.workerCommand.createMany({
      data: [
        {
          payload: { type: 'stop', userId: 'u', sessionId: 's1' },
          status: 'PENDING',
          createdAt: oldPendingCreatedAt,
        },
        {
          payload: { type: 'stop', userId: 'u', sessionId: 's2' },
          status: 'PENDING',
        },
        {
          payload: { type: 'stop', userId: 'u', sessionId: 's3' },
          status: 'CLAIMED',
          claimedAt: new Date(),
        },
        {
          payload: { type: 'stop', userId: 'u', sessionId: 's4' },
          status: 'DONE',
          completedAt: new Date(),
        },
        {
          payload: { type: 'stop', userId: 'u', sessionId: 's5' },
          status: 'FAILED',
          completedAt: new Date(),
          lastError: 'boom',
        },
      ],
    });

    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/status/snapshot',
      cookies: { accessToken },
    });
    const body = JSON.parse(res.body);

    expect(body.queue.pending).toBe(2);
    expect(body.queue.claimed).toBe(1);
    expect(body.queue.failed).toBe(1);
    // Oldest PENDING is ~30 s old; allow slack for test overhead.
    expect(body.queue.oldestPendingAgeMs).toBeGreaterThanOrEqual(29_000);
    expect(body.queue.oldestPendingAgeMs).toBeLessThan(60_000);
  });

  it('returns the latest ~10 failures in recentFailures, newest-first, with payload fields lifted', async () => {
    const { accessToken } = await registerUser({ email: ADMIN_EMAIL, admin: true });

    // Seed 12 failures; we expect the 10 most recent by completedAt desc.
    const base = Date.now();
    const rows = Array.from({ length: 12 }).map((_, i) => ({
      payload: { type: 'stop', userId: 'u', sessionId: `s-${i}` },
      status: 'FAILED' as const,
      completedAt: new Date(base - (12 - i) * 1000),
      lastError: i === 11 ? 'newest' : `err-${i}`,
    }));
    await prisma.workerCommand.createMany({ data: rows });

    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/status/snapshot',
      cookies: { accessToken },
    });
    const body = JSON.parse(res.body);

    expect(body.queue.failed).toBe(12);
    expect(body.queue.recentFailures).toHaveLength(10);
    expect(body.queue.recentFailures[0].sessionId).toBe('s-11');
    expect(body.queue.recentFailures[0].type).toBe('stop');
    expect(body.queue.recentFailures[0].lastError).toBe('newest');
    expect(body.queue.recentFailures[0].completedAt).toBeTypeOf('string');
    expect(body.queue.recentFailures[0].id).toBeTypeOf('string');
  });

  it('includes active sessions with user email, status filter, and nested outputs', async () => {
    const { accessToken } = await registerUser({ email: ADMIN_EMAIL, admin: true });
    // An extra, non-admin user who owns the session we'll assert on.
    await registerUser({ email: 'session-owner@example.com' });
    const owner = await prisma.user.findUniqueOrThrow({
      where: { email: 'session-owner@example.com' },
    });

    const output = await prisma.output.create({
      data: {
        userId: owner.id,
        name: 'Twitch Main',
        platform: 'TWITCH',
        rtmpUrl: 'rtmp://live.twitch.tv/app',
        streamKey: 'twitch-key',
      },
    });

    const liveSession = await prisma.streamSession.create({
      data: { userId: owner.id, status: 'LIVE' },
    });
    await prisma.outputSession.create({
      data: {
        sessionId: liveSession.id,
        outputId: output.id,
        status: 'LIVE',
      },
    });

    // STOPPED session must not appear (status filter = STARTING|LIVE|ERROR).
    await prisma.streamSession.create({
      data: { userId: owner.id, status: 'STOPPED' },
    });

    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/status/snapshot',
      cookies: { accessToken },
    });
    const body = JSON.parse(res.body);

    expect(body.sessions).toHaveLength(1);
    const s = body.sessions[0];
    expect(s.sessionId).toBe(liveSession.id);
    expect(s.userId).toBe(owner.id);
    expect(s.userEmail).toBe('session-owner@example.com');
    expect(s.status).toBe('LIVE');
    expect(s.startedAt).toBeTypeOf('string');
    expect(s.outputs).toHaveLength(1);
    expect(s.outputs[0].name).toBe('Twitch Main');
    expect(s.outputs[0].platform).toBe('TWITCH');
    expect(s.outputs[0].status).toBe('LIVE');
  });

  it('joins mediamtx publishers to user emails by streamKey, leaving unknown keys as null', async () => {
    const { accessToken } = await registerUser({ email: ADMIN_EMAIL, admin: true });

    // Admin user already created with a known streamKey. Give the publisher
    // list one row that matches it and one that's an orphan.
    const admin = await prisma.user.findUniqueOrThrow({
      where: { email: ADMIN_EMAIL },
    });
    const now = new Date().toISOString();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          items: [
            {
              name: `live/${admin.streamKey}`,
              ready: true,
              readyTime: now,
              source: { type: 'rtmpConn', id: 'c1' },
            },
            {
              name: 'live/orphan-key',
              ready: true,
              readyTime: now,
              source: { type: 'srtConn', id: 'c2' },
            },
          ],
        };
      },
    }) as unknown as typeof fetch;

    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/status/snapshot',
      cookies: { accessToken },
    });
    const body = JSON.parse(res.body);

    expect(body.mediamtx.reachable).toBe(true);
    expect(body.mediamtx.byProtocol).toEqual({ rtmp: 1, srt: 1 });
    expect(body.mediamtx.publishers).toHaveLength(2);

    const admins = body.mediamtx.publishers.find(
      (p: any) => p.streamKey === admin.streamKey,
    );
    expect(admins.userEmail).toBe(ADMIN_EMAIL);
    expect(admins.protocol).toBe('rtmp');

    const orphan = body.mediamtx.publishers.find(
      (p: any) => p.streamKey === 'orphan-key',
    );
    expect(orphan.userEmail).toBe(null);
    expect(orphan.protocol).toBe('srt');
  });

  it('surfaces mediamtx.reachable=false when the MediaMTX fetch fails', async () => {
    const { accessToken } = await registerUser({ email: ADMIN_EMAIL, admin: true });
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/status/snapshot',
      cookies: { accessToken },
    });
    const body = JSON.parse(res.body);

    expect(body.mediamtx.reachable).toBe(false);
    expect(body.mediamtx.publishers).toEqual([]);
    expect(body.mediamtx.byProtocol).toEqual({ rtmp: 0, srt: 0 });
  });
});

/**
 * SSE tests need a real listening socket — `app.inject` resolves once the
 * handler returns, which doesn't model the long-lived stream semantics we
 * care about (initial chunk delivery, write-after-close behaviour). We start
 * the shared app on a random loopback port and use `ORIGINAL_FETCH` so the
 * test client bypasses the globalThis.fetch mock that's in place for the
 * server-side MediaMTX call.
 */
describe('GET /admin/status/stream — SSE', () => {
  let baseUrl: string;

  beforeAll(async () => {
    const app = await getApp();
    if (!app.server.listening) {
      await app.listen({ port: 0, host: '127.0.0.1' });
    }
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port assigned');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  it('returns 401 without an access token', async () => {
    const res = await ORIGINAL_FETCH(`${baseUrl}/admin/status/stream`);
    expect(res.status).toBe(401);
    await res.text();
  });

  it('returns 403 for a valid JWT whose email is not an admin', async () => {
    delete process.env.ADMIN_EMAILS;
    const { accessToken } = await registerUser({ email: 'sse-not-admin@example.com' });
    const res = await ORIGINAL_FETCH(`${baseUrl}/admin/status/stream`, {
      headers: { cookie: `accessToken=${accessToken}` },
    });
    expect(res.status).toBe(403);
    await res.text();
  });

  it('delivers an initial snapshot envelope to an admin and cleans up on client abort', async () => {
    const { accessToken } = await registerUser({ email: ADMIN_EMAIL, admin: true });
    const controller = new AbortController();
    const res = await ORIGINAL_FETCH(`${baseUrl}/admin/status/stream`, {
      headers: { cookie: `accessToken=${accessToken}` },
      signal: controller.signal,
    });
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const chunk = new TextDecoder().decode(value);

      expect(chunk.startsWith('data: ')).toBe(true);
      const json = JSON.parse(chunk.slice('data: '.length).trim());
      expect(json).toMatchObject({
        queue: expect.any(Object),
        sessions: expect.any(Array),
        mediamtx: expect.objectContaining({ reachable: expect.any(Boolean) }),
        generatedAt: expect.any(String),
      });
    } finally {
      // Aborting the client triggers the server's `close` listener, which
      // calls cleanup(). If cleanup leaked, the test runner would hang on the
      // 5 s SSE interval; the test suite finishing is itself the assertion.
      controller.abort();
    }
  });
});
