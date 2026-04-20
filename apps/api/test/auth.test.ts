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

    const accessCookie = cookies.find((c: any) => c.name === 'accessToken');
    expect(accessCookie).toBeDefined();
    expect(accessCookie!.httpOnly).toBe(true);
    expect(accessCookie!.path).toBe('/');
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

    const accessCookie = res.cookies.find((c: any) => c.name === 'accessToken');
    expect(accessCookie).toBeDefined();
    expect(accessCookie!.httpOnly).toBe(true);
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

    const accessCookie = res.cookies.find((c: any) => c.name === 'accessToken');
    expect(accessCookie).toBeDefined();
    expect(accessCookie!.httpOnly).toBe(true);
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

describe('POST /auth/logout', () => {
  it('clears both cookies without requiring authentication', async () => {
    const { response: regRes } = await registerUser({ email: 'logout@example.com' });
    const refreshCookie = regRes.cookies.find((c: any) => c.name === 'refreshToken');
    const accessCookie = regRes.cookies.find((c: any) => c.name === 'accessToken');
    const app = await getApp();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: {
        refreshToken: refreshCookie!.value,
        accessToken: accessCookie!.value,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('logged_out');

    // Both cookies should be cleared
    const clearedAccess = res.cookies.find((c: any) => c.name === 'accessToken');
    const clearedRefresh = res.cookies.find((c: any) => c.name === 'refreshToken');
    expect(clearedAccess).toBeDefined();
    expect(clearedRefresh).toBeDefined();
  });

  it('succeeds even without any cookies (unauthenticated no-op)', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('logged_out');
  });
});

describe('GET /auth/me', () => {
  const originalAdminEmails = process.env.ADMIN_EMAILS;
  afterAll(() => {
    if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalAdminEmails;
  });

  it('returns 401 when no access token is present', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns { id, email, isAdmin:false } for a non-admin user', async () => {
    delete process.env.ADMIN_EMAILS;
    const { response: regRes, body: regBody } = await registerUser({
      email: 'me-nonadmin@example.com',
    });
    const accessCookie = regRes.cookies.find((c: any) => c.name === 'accessToken');
    const app = await getApp();

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { accessToken: accessCookie!.value },
    });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.email).toBe('me-nonadmin@example.com');
    expect(body.id).toBeTypeOf('string');
    expect(body.isAdmin).toBe(false);
    // Password hash etc must never leak in /auth/me.
    expect(body).not.toHaveProperty('passwordHash');
    expect(regBody.accessToken).toBeTypeOf('string');
  });

  it('returns isAdmin:true when the user email is in ADMIN_EMAILS', async () => {
    process.env.ADMIN_EMAILS = 'me-admin@example.com';
    const { response: regRes } = await registerUser({ email: 'me-admin@example.com' });
    const accessCookie = regRes.cookies.find((c: any) => c.name === 'accessToken');
    const app = await getApp();

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { accessToken: accessCookie!.value },
    });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.email).toBe('me-admin@example.com');
    expect(body.isAdmin).toBe(true);
  });
});

describe('cookie-only authentication', () => {
  it('allows access to protected routes using only the accessToken cookie', async () => {
    const { response: regRes } = await registerUser({ email: 'cookieauth@example.com' });
    const accessCookie = regRes.cookies.find((c: any) => c.name === 'accessToken');
    const app = await getApp();

    // Call a protected route with only the cookie (no Authorization header)
    const res = await app.inject({
      method: 'GET',
      url: '/stream',
      cookies: { accessToken: accessCookie!.value },
    });

    // Should not be 401 — the cookie should authenticate the request
    expect(res.statusCode).not.toBe(401);
  });
});
