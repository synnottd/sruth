import { describe, it, expect, afterAll } from 'vitest';
import { getApp, closeApp, registerUser } from './helper.js';

afterAll(() => closeApp());

/** Helper: register and return an auth header */
async function authHeader(email = 'outputs@example.com') {
  const { body } = await registerUser({ email });
  return { authorization: `Bearer ${body.accessToken}` };
}

describe('POST /outputs', () => {
  it('creates an output destination', async () => {
    const headers = await authHeader();
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/outputs',
      headers,
      payload: {
        name: 'My Twitch',
        platform: 'TWITCH',
        rtmpUrl: 'rtmp://live.twitch.tv/app',
        streamKey: 'live_abc123',
      },
    });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(201);
    expect(body.id).toBeTypeOf('string');
    expect(body.name).toBe('My Twitch');
    expect(body.platform).toBe('TWITCH');
    expect(body.enabled).toBe(true);
  });

  it('rejects creating more than 5 outputs', async () => {
    const headers = await authHeader('limit@example.com');
    const app = await getApp();

    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/outputs',
        headers,
        payload: {
          name: `Output ${i}`,
          platform: 'CUSTOM',
          rtmpUrl: 'rtmp://example.com/live',
          streamKey: `key_${i}`,
        },
      });
    }

    const res = await app.inject({
      method: 'POST',
      url: '/outputs',
      headers,
      payload: {
        name: 'Output 6',
        platform: 'CUSTOM',
        rtmpUrl: 'rtmp://example.com/live',
        streamKey: 'key_6',
      },
    });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(422);
    expect(body.error).toBe('MAX_OUTPUTS_REACHED');
  });
});

describe('GET /outputs', () => {
  it('lists only the authenticated user outputs', async () => {
    const headers = await authHeader('list@example.com');
    const app = await getApp();

    await app.inject({
      method: 'POST',
      url: '/outputs',
      headers,
      payload: {
        name: 'YouTube',
        platform: 'YOUTUBE',
        rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
        streamKey: 'yt_key',
      },
    });

    const res = await app.inject({ method: 'GET', url: '/outputs', headers });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('YouTube');
  });
});

describe('PUT /outputs/:id', () => {
  it('updates an output', async () => {
    const headers = await authHeader('update@example.com');
    const app = await getApp();

    const createRes = await app.inject({
      method: 'POST',
      url: '/outputs',
      headers,
      payload: {
        name: 'Old Name',
        platform: 'TWITCH',
        rtmpUrl: 'rtmp://live.twitch.tv/app',
        streamKey: 'twitch_key',
      },
    });
    const { id } = JSON.parse(createRes.body);

    const res = await app.inject({
      method: 'PUT',
      url: `/outputs/${id}`,
      headers,
      payload: { name: 'New Name' },
    });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.name).toBe('New Name');
  });
});

describe('DELETE /outputs/:id', () => {
  it('soft deletes an output (gone from list)', async () => {
    const headers = await authHeader('delete@example.com');
    const app = await getApp();

    const createRes = await app.inject({
      method: 'POST',
      url: '/outputs',
      headers,
      payload: {
        name: 'To Delete',
        platform: 'FACEBOOK',
        rtmpUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/',
        streamKey: 'fb_key',
      },
    });
    const { id } = JSON.parse(createRes.body);

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/outputs/${id}`,
      headers,
    });
    expect(delRes.statusCode).toBe(204);

    const listRes = await app.inject({ method: 'GET', url: '/outputs', headers });
    const list = JSON.parse(listRes.body);
    expect(list).toHaveLength(0);
  });
});
