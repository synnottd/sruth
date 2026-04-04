import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (!app) {
    app = await buildApp();
    await app.ready();
  }
  return app;
}

export async function closeApp(): Promise<void> {
  if (app) {
    await app.close();
    app = null;
  }
}

/** Register a user and return tokens + stream key */
export async function registerUser(
  overrides: { email?: string; password?: string } = {},
) {
  const a = await getApp();
  const res = await a.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: overrides.email ?? 'test@example.com',
      password: overrides.password ?? 'password123',
    },
  });
  return { response: res, body: JSON.parse(res.body) };
}
