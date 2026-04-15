import { describe, it, expect, afterAll, vi } from 'vitest';
import { getApp, getInternalApp, closeApp, registerUser } from './helper.js';

// Mock commands for on-publish
vi.mock('../src/lib/commands.js', () => ({
  sendCommand: vi.fn(),
}));

afterAll(() => closeApp());

const INTERNAL_HEADERS = { 'x-internal-secret': process.env.INTERNAL_SECRET ?? 'test-secret' };

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
    const internal = await getInternalApp();

    // Create an output so on-publish can create a session
    await app.inject({
      method: 'POST',
      url: '/outputs',
      headers,
      payload: {
        name: 'Test Output',
        platform: 'TWITCH',
        rtmpUrl: 'rtmp://live.twitch.tv/app',
        streamKey: 'live_test',
      },
    });

    // Simulate active stream via on-publish (creates STARTING session in DB)
    await internal.inject({
      method: 'POST',
      url: '/internal/stream/on-publish',
      payload: `app=live&name=${streamKey}&addr=10.0.0.1`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...INTERNAL_HEADERS },
    });

    const res = await app.inject({ method: 'POST', url: '/stream/key/rotate', headers });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(409);
    expect(body.error).toBe('STREAM_IS_LIVE');
  });
});
