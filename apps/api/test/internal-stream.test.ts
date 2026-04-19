import { describe, it, expect, afterAll, vi } from 'vitest';
import { getApp, getInternalApp, closeApp, registerUser } from './helper.js';

// Mock commands — new Postgres-based command queue
vi.mock('../src/lib/commands.js', () => ({
  sendCommand: vi.fn(),
}));

afterAll(() => closeApp());

const INTERNAL_HEADERS = { 'x-internal-secret': process.env.INTERNAL_SECRET ?? 'test-secret' };

/** Create an enabled output for a user */
async function createOutput(email: string, headers: Record<string, string>) {
  const app = await getApp();
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
}

describe('POST /internal/stream/on-publish', () => {
  it('accepts valid stream key and creates session', async () => {
    const { body } = await registerUser({ email: 'publish@example.com' });
    const internal = await getInternalApp();

    // Create an output so the session has outputs
    await createOutput('publish@example.com', { authorization: `Bearer ${body.accessToken}` });

    const res = await internal.inject({
      method: 'POST',
      url: '/internal/stream/on-publish',
      payload: `app=live&name=${body.streamKey}&addr=10.0.0.1`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...INTERNAL_HEADERS },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ok');
  });

  it('rejects unknown stream key with 401', async () => {
    const internal = await getInternalApp();
    const res = await internal.inject({
      method: 'POST',
      url: '/internal/stream/on-publish',
      payload: 'app=live&name=nonexistent-key&addr=10.0.0.1',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...INTERNAL_HEADERS },
    });

    expect(res.statusCode).toBe(401);
  });

  it('rejects without valid internal secret', async () => {
    const internal = await getInternalApp();
    const res = await internal.inject({
      method: 'POST',
      url: '/internal/stream/on-publish',
      payload: 'app=live&name=some-key&addr=10.0.0.1',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-internal-secret': 'wrong' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('resumes existing LIVE/STARTING session', async () => {
    const { body } = await registerUser({ email: 'resume@example.com' });
    const internal = await getInternalApp();

    await createOutput('resume@example.com', { authorization: `Bearer ${body.accessToken}` });

    // First on-publish creates the session
    await internal.inject({
      method: 'POST',
      url: '/internal/stream/on-publish',
      payload: `app=live&name=${body.streamKey}&addr=10.0.0.1`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...INTERNAL_HEADERS },
    });

    // Second on-publish should resume
    const res = await internal.inject({
      method: 'POST',
      url: '/internal/stream/on-publish',
      payload: `app=live&name=${body.streamKey}&addr=10.0.0.2`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...INTERNAL_HEADERS },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('resumed');
  });
});
