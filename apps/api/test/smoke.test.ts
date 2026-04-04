import { describe, it, expect, afterAll } from 'vitest';
import { getApp, closeApp } from './helper.js';

afterAll(() => closeApp());

describe('smoke', () => {
  it('server boots and returns 404 for unknown routes', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/nonexistent' });
    expect(res.statusCode).toBe(404);
  });
});
