import { describe, it, expect, afterAll, vi } from 'vitest';
import { getApp, closeApp } from './helper.js';

afterAll(() => closeApp());

describe('GET /health', () => {
  it('returns 200 when Prisma and Redis are healthy', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('returns 503 when Prisma is down', async () => {
    const app = await getApp();
    const spy = vi.spyOn(app.prisma, '$queryRaw' as any).mockRejectedValueOnce(new Error('db down'));

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ status: 'unhealthy' });

    spy.mockRestore();
  });

  it('returns 503 when Redis is down', async () => {
    const app = await getApp();
    const spy = vi.spyOn(app.redis, 'ping').mockRejectedValueOnce(new Error('redis down'));

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ status: 'unhealthy' });

    spy.mockRestore();
  });
});
