import { buildApp, buildInternalApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance | null = null;
let internalApp: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (!app) {
    app = await buildApp();
    await app.ready();
  }
  return app;
}

export async function getInternalApp(): Promise<FastifyInstance> {
  if (!internalApp) {
    process.env.INTERNAL_SECRET ??= 'test-secret';
    internalApp = await buildInternalApp();
    await internalApp.ready();
  }
  return internalApp;
}

export async function closeApp(): Promise<void> {
  if (app) {
    await app.close();
    app = null;
  }
  if (internalApp) {
    await internalApp.close();
    internalApp = null;
  }
}

/**
 * Register a user and return tokens + stream key.
 *
 * Pass `admin: true` to append the email to `process.env.ADMIN_EMAILS` so the
 * registered user passes the `authenticateAdmin` decorator. Tests are
 * responsible for restoring ADMIN_EMAILS afterwards.
 */
export async function registerUser(
  overrides: { email?: string; password?: string; admin?: boolean } = {},
) {
  const email = overrides.email ?? 'test@example.com';
  if (overrides.admin) {
    const list = (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!list.includes(email)) list.push(email);
    process.env.ADMIN_EMAILS = list.join(',');
  }
  const a = await getApp();
  const res = await a.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email,
      password: overrides.password ?? 'password123',
    },
  });
  const accessCookie = res.cookies.find((c: any) => c.name === 'accessToken');
  return {
    response: res,
    body: JSON.parse(res.body),
    accessToken: accessCookie?.value ?? '',
  };
}
