import { describe, it, expect, afterAll, vi } from 'vitest';
import { getApp, getInternalApp, closeApp, registerUser } from './helper.js';

// Mock SQS - external AWS service
vi.mock('../src/lib/sqs.js', () => ({
  sendCommand: vi.fn(),
}));

afterAll(() => closeApp());

const INTERNAL_HEADERS = { 'x-internal-secret': process.env.INTERNAL_SECRET ?? 'test-secret' };

/** Register a user and return their stream key */
async function getStreamKey(email = 'ingest@example.com') {
  const { body } = await registerUser({ email });
  return body.streamKey as string;
}

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

    // Verify Redis state was set
    const activeSession = await internal.redis.get(`stream:${body.streamKey}:active`);
    expect(activeSession).toBeTypeOf('string');
    const ingestIp = await internal.redis.get(`stream:${body.streamKey}:ingest_ip`);
    expect(ingestIp).toBe('10.0.0.1');
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

  it('rejects during cooldown with 429', async () => {
    const streamKey = await getStreamKey('cooldown@example.com');
    const internal = await getInternalApp();

    // Set cooldown key
    await internal.redis.set(`stream:${streamKey}:cooldown`, '1', 'EX', 3);

    const res = await internal.inject({
      method: 'POST',
      url: '/internal/stream/on-publish',
      payload: `app=live&name=${streamKey}&addr=10.0.0.1`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...INTERNAL_HEADERS },
    });

    expect(res.statusCode).toBe(429);
  });

  it('rejects duplicate from same IP with 409', async () => {
    const streamKey = await getStreamKey('dup@example.com');
    const internal = await getInternalApp();

    // Simulate existing active session from same IP
    await internal.redis.set(`stream:${streamKey}:active`, 'existing-session', 'EX', 3600);
    await internal.redis.set(`stream:${streamKey}:ingest_ip`, '10.0.0.1', 'EX', 3600);

    const res = await internal.inject({
      method: 'POST',
      url: '/internal/stream/on-publish',
      payload: `app=live&name=${streamKey}&addr=10.0.0.1`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...INTERNAL_HEADERS },
    });

    expect(res.statusCode).toBe(409);
  });

  it('handles failover from different IP', async () => {
    const streamKey = await getStreamKey('failover@example.com');
    const internal = await getInternalApp();

    // Simulate existing active session from different IP
    await internal.redis.set(`stream:${streamKey}:active`, 'existing-session', 'EX', 3600);
    await internal.redis.set(`stream:${streamKey}:ingest_ip`, '10.0.0.1', 'EX', 3600);

    const res = await internal.inject({
      method: 'POST',
      url: '/internal/stream/on-publish',
      payload: `app=live&name=${streamKey}&addr=10.0.0.2`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...INTERNAL_HEADERS },
    });

    expect(res.statusCode).toBe(200);

    // Verify IP was updated
    const newIp = await internal.redis.get(`stream:${streamKey}:ingest_ip`);
    expect(newIp).toBe('10.0.0.2');
  });
});

describe('POST /internal/stream/on-publish-done', () => {
  it('stops session and cleans up Redis', async () => {
    const { body } = await registerUser({ email: 'done@example.com' });
    const internal = await getInternalApp();

    // Create output and simulate on_publish first
    await createOutput('done@example.com', { authorization: `Bearer ${body.accessToken}` });
    await internal.inject({
      method: 'POST',
      url: '/internal/stream/on-publish',
      payload: `app=live&name=${body.streamKey}&addr=10.0.0.1`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...INTERNAL_HEADERS },
    });

    // Now call on_publish_done
    const res = await internal.inject({
      method: 'POST',
      url: '/internal/stream/on-publish-done',
      payload: `app=live&name=${body.streamKey}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...INTERNAL_HEADERS },
    });

    expect(res.statusCode).toBe(200);

    // Redis keys should be cleaned up
    const active = await internal.redis.get(`stream:${body.streamKey}:active`);
    expect(active).toBeNull();
    const ip = await internal.redis.get(`stream:${body.streamKey}:ingest_ip`);
    expect(ip).toBeNull();
  });
});
