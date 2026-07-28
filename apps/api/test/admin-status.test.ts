import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { getApp, closeApp, registerUser } from './helper.js';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * End-to-end tests for the /admin/status/snapshot route. These exercise auth
 * gating, the three-way composition (queue / sessions / MediaMTX), and the
 * publisher↔user email join. MediaMTX HTTP is mocked by stubbing globalThis.fetch.
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ADMIN_EMAILS = process.env.ADMIN_EMAILS;

async function setupAdminUser() {
  process.env.ADMIN_EMAILS = 'admin-dash@example.com';
  const { response } = await registerUser({ email: 'admin-dash@example.com' });
  const accessCookie = response.cookies.find((c: any) => c.name === 'accessToken');
  return accessCookie!.value;
}

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
    const { response } = await registerUser({ email: 'not-an-admin@example.com' });
    const accessCookie = response.cookies.find((c: any) => c.name === 'accessToken');
    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/status/snapshot',
      cookies: { accessToken: accessCookie!.value },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 200 for an admin', async () => {
    const token = await setupAdminUser();
    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/status/snapshot',
      cookies: { accessToken: token },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /admin/status/snapshot — shape', () => {
  it('returns the full snapshot envelope with generatedAt and empty collections when the DB is empty', async () => {
    const token = await setupAdminUser();
    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/status/snapshot',
      cookies: { accessToken: token },
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
    const token = await setupAdminUser();

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
      cookies: { accessToken: token },
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
    const token = await setupAdminUser();

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
      cookies: { accessToken: token },
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
    const token = await setupAdminUser();
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
      cookies: { accessToken: token },
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
    const token = await setupAdminUser();

    // Admin user already created with a known streamKey. Give the publisher
    // list one row that matches it and one that's an orphan.
    const admin = await prisma.user.findUniqueOrThrow({
      where: { email: 'admin-dash@example.com' },
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
      cookies: { accessToken: token },
    });
    const body = JSON.parse(res.body);

    expect(body.mediamtx.reachable).toBe(true);
    expect(body.mediamtx.byProtocol).toEqual({ rtmp: 1, srt: 1 });
    expect(body.mediamtx.publishers).toHaveLength(2);

    const admins = body.mediamtx.publishers.find(
      (p: any) => p.streamKey === admin.streamKey,
    );
    expect(admins.userEmail).toBe('admin-dash@example.com');
    expect(admins.protocol).toBe('rtmp');

    const orphan = body.mediamtx.publishers.find(
      (p: any) => p.streamKey === 'orphan-key',
    );
    expect(orphan.userEmail).toBe(null);
    expect(orphan.protocol).toBe('srt');
  });

  it('surfaces mediamtx.reachable=false when the MediaMTX fetch fails', async () => {
    const token = await setupAdminUser();
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/status/snapshot',
      cookies: { accessToken: token },
    });
    const body = JSON.parse(res.body);

    expect(body.mediamtx.reachable).toBe(false);
    expect(body.mediamtx.publishers).toEqual([]);
    expect(body.mediamtx.byProtocol).toEqual({ rtmp: 0, srt: 0 });
  });
});
