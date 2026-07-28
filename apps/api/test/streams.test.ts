import { describe, it, expect, afterAll, vi } from 'vitest';
import { getApp, getInternalApp, closeApp, registerUser } from './helper.js';

vi.mock('../src/lib/commands.js', () => ({
  sendCommand: vi.fn(),
}));

afterAll(() => closeApp());

const INTERNAL_HEADERS = { 'x-internal-secret': process.env.INTERNAL_SECRET ?? 'test-secret' };

/** Set up a user with an active stream session */
async function setupActiveStream(email: string) {
  const { body } = await registerUser({ email });
  const app = await getApp();
  const internal = await getInternalApp();
  const headers = { authorization: `Bearer ${body.accessToken}` };

  // Create output
  const outputRes = await app.inject({
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
  const output = JSON.parse(outputRes.body);

  // Simulate on_publish via internal app
  await internal.inject({
    method: 'POST',
    url: '/internal/stream/on-publish',
    payload: `app=live&name=${body.streamKey}&addr=10.0.0.1`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...INTERNAL_HEADERS },
  });

  return { headers, streamKey: body.streamKey, outputId: output.id };
}

describe('GET /streams/active', () => {
  it('returns active streams with output sessions', async () => {
    const { headers } = await setupActiveStream('active@example.com');
    const app = await getApp();

    const res = await app.inject({ method: 'GET', url: '/streams/active', headers });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].status).toBe('STARTING');
    expect(body[0].outputSessions).toHaveLength(1);
  });
});

describe('POST /streams/:outputId/stop (removed)', () => {
  it('returns 404 — replaced by the PUT /outputs/:id enabled toggle', async () => {
    const { headers } = await setupActiveStream('stop@example.com');
    const app = await getApp();

    const activeRes = await app.inject({ method: 'GET', url: '/streams/active', headers });
    const active = JSON.parse(activeRes.body);
    const outputSessionId = active[0].outputSessions[0].id;

    const res = await app.inject({
      method: 'POST',
      url: `/streams/${outputSessionId}/stop`,
      headers,
    });
    expect(res.statusCode).toBe(404);
  });
});
