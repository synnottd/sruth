import { describe, it, expect, afterAll } from 'vitest';
import { getApp, closeApp, registerUser } from './helper.js';

afterAll(() => closeApp());

async function authHeader(email = 'stream@example.com') {
  const { body } = await registerUser({ email });
  return { headers: { authorization: `Bearer ${body.accessToken}` }, streamKey: body.streamKey };
}

describe('GET /stream', () => {
  it('returns ingest URL and stream key', async () => {
    const { headers, streamKey } = await authHeader();
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/stream', headers });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.streamKey).toBe(streamKey);
    expect(body.ingestUrl).toBeTypeOf('string');
  });
});

describe('POST /stream/key/rotate', () => {
  it('returns a new stream key when not live', async () => {
    const { headers, streamKey: oldKey } = await authHeader('rotate@example.com');
    const app = await getApp();
    const res = await app.inject({ method: 'POST', url: '/stream/key/rotate', headers });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.streamKey).toBeTypeOf('string');
    expect(body.streamKey).not.toBe(oldKey);
  });

  it('returns 409 when stream is live', async () => {
    const { headers, streamKey } = await authHeader('live@example.com');
    const app = await getApp();

    // Simulate active stream in Redis
    await app.redis.set(`stream:${streamKey}:active`, 'fake-session-id', 'EX', 3600);

    const res = await app.inject({ method: 'POST', url: '/stream/key/rotate', headers });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(409);
    expect(body.error).toBe('STREAM_IS_LIVE');
  });
});
