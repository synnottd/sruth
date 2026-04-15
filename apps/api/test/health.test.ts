import { describe, it, expect, afterAll, vi } from 'vitest';
import { getApp, closeApp } from './helper.js';

afterAll(() => closeApp());

describe('GET /health', () => {
  it('returns 200 when Prisma is healthy', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns 503 when Prisma is down', async () => {
    const app = await getApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(app.prisma as any, '$queryRaw').mockRejectedValueOnce(new Error('db down'));

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unhealthy' });

    spy.mockRestore();
  });
});
