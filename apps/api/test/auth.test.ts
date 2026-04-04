import { describe, it, expect, afterAll } from 'vitest';
import { getApp, closeApp, registerUser } from './helper.js';

afterAll(() => closeApp());

describe('POST /auth/register', () => {
  it('returns access token, refresh cookie, and stream key', async () => {
    const { response, body } = await registerUser();

    expect(response.statusCode).toBe(201);
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.streamKey).toBeTypeOf('string');

    const cookies = response.cookies;
    const refreshCookie = cookies.find((c: any) => c.name === 'refreshToken');
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie!.httpOnly).toBe(true);
  });

  it('rejects duplicate email with 409', async () => {
    await registerUser({ email: 'dupe@example.com' });
    const { response, body } = await registerUser({ email: 'dupe@example.com' });

    expect(response.statusCode).toBe(409);
    expect(body.error).toBe('EMAIL_TAKEN');
  });

  it('rejects invalid input with 400', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'bad@example.com', password: 'short' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('VALIDATION_ERROR');
  });
});

describe('POST /auth/login', () => {
  it('returns access token and refresh cookie for valid credentials', async () => {
    await registerUser({ email: 'login@example.com', password: 'password123' });
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'login@example.com', password: 'password123' },
    });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.accessToken).toBeTypeOf('string');
    const refreshCookie = res.cookies.find((c: any) => c.name === 'refreshToken');
    expect(refreshCookie).toBeDefined();
  });

  it('rejects wrong password with 401', async () => {
    await registerUser({ email: 'wrong@example.com', password: 'password123' });
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'wrong@example.com', password: 'wrongpassword' },
    });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(401);
    expect(body.error).toBe('INVALID_CREDENTIALS');
  });
});

describe('POST /auth/refresh', () => {
  it('exchanges refresh cookie for new token pair', async () => {
    const { response: regRes } = await registerUser({ email: 'refresh@example.com' });
    const refreshCookie = regRes.cookies.find((c: any) => c.name === 'refreshToken');
    const app = await getApp();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { refreshToken: refreshCookie!.value },
    });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.accessToken).toBeTypeOf('string');
    const newRefreshCookie = res.cookies.find((c: any) => c.name === 'refreshToken');
    expect(newRefreshCookie).toBeDefined();
    // New refresh cookie should differ from old one (rotation)
    expect(newRefreshCookie!.value).not.toBe(refreshCookie!.value);
  });

  it('rejects invalid refresh token with 401', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { refreshToken: 'invalid-token' },
    });

    expect(res.statusCode).toBe(401);
  });
});
