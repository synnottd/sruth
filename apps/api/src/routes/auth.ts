import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const SALT_ROUNDS = 12;
const REFRESH_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

export default async function authRoutes(fastify: FastifyInstance) {
  await fastify.register(rateLimit, {
    max: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
  });
  fastify.post<{
    Body: { email: string; password: string };
  }>('/auth/register', async (request, reply) => {
    const { email: rawEmail, password } = request.body;
    const email = rawEmail?.toLowerCase().trim();

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email) || !password || password.length < 8) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'VALIDATION_ERROR',
        message: 'Valid email and password (min 8 chars) are required',
      });
    }

    const existing = await fastify.prisma.user.findFirst({ where: { email } });
    if (existing) {
      return reply.code(409).send({
        statusCode: 409,
        error: 'EMAIL_TAKEN',
        message: 'An account with this email already exists',
      });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await fastify.prisma.user.create({
      data: { email, passwordHash },
    });

    const accessToken = fastify.jwt.sign(
      { sub: user.id, email: user.email },
      { expiresIn: process.env.JWT_ACCESS_EXPIRY ?? '15m' },
    );

    const tokenId = crypto.randomUUID();
    const refreshToken = fastify.jwt.sign(
      { sub: user.id, tokenId },
      { expiresIn: process.env.JWT_REFRESH_EXPIRY ?? '7d' },
    );

    await fastify.redis.set(
      `refresh:${user.id}:${tokenId}`,
      '1',
      'EX',
      REFRESH_EXPIRY_SECONDS,
    );

    reply
      .setCookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/auth',
        maxAge: REFRESH_EXPIRY_SECONDS,
      })
      .code(201)
      .send({
        accessToken,
        streamKey: user.streamKey,
      });
  });

  fastify.post<{
    Body: { email: string; password: string };
  }>('/auth/login', async (request, reply) => {
    const { email: rawEmail, password } = request.body ?? {};
    const email = rawEmail?.toLowerCase().trim();

    if (!email || !password) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'VALIDATION_ERROR',
        message: 'Email and password are required',
      });
    }

    const user = await fastify.prisma.user.findFirst({ where: { email } });
    if (!user) {
      return reply.code(401).send({
        statusCode: 401,
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return reply.code(401).send({
        statusCode: 401,
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }

    const accessToken = fastify.jwt.sign(
      { sub: user.id, email: user.email },
      { expiresIn: process.env.JWT_ACCESS_EXPIRY ?? '15m' },
    );

    const tokenId = crypto.randomUUID();
    const refreshToken = fastify.jwt.sign(
      { sub: user.id, tokenId },
      { expiresIn: process.env.JWT_REFRESH_EXPIRY ?? '7d' },
    );

    await fastify.redis.set(
      `refresh:${user.id}:${tokenId}`,
      '1',
      'EX',
      REFRESH_EXPIRY_SECONDS,
    );

    reply
      .setCookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/auth',
        maxAge: REFRESH_EXPIRY_SECONDS,
      })
      .code(200)
      .send({ accessToken });
  });

  fastify.post('/auth/refresh', async (request, reply) => {
    const token = request.cookies.refreshToken;
    if (!token) {
      return reply.code(401).send({
        statusCode: 401,
        error: 'NO_REFRESH_TOKEN',
        message: 'Refresh token cookie is missing',
      });
    }

    let payload: { sub: string; tokenId: string };
    try {
      payload = fastify.jwt.verify<{ sub: string; tokenId: string }>(token);
    } catch {
      return reply.code(401).send({
        statusCode: 401,
        error: 'INVALID_REFRESH_TOKEN',
        message: 'Refresh token is invalid or expired',
      });
    }

    // Check token exists in Redis (not revoked)
    const redisKey = `refresh:${payload.sub}:${payload.tokenId}`;
    const exists = await fastify.redis.exists(redisKey);
    if (!exists) {
      return reply.code(401).send({
        statusCode: 401,
        error: 'REVOKED_REFRESH_TOKEN',
        message: 'Refresh token has been revoked',
      });
    }

    // Revoke old token
    await fastify.redis.del(redisKey);

    const user = await fastify.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user) {
      return reply.code(401).send({
        statusCode: 401,
        error: 'USER_NOT_FOUND',
        message: 'User no longer exists',
      });
    }

    // Issue new pair
    const accessToken = fastify.jwt.sign(
      { sub: user.id, email: user.email },
      { expiresIn: process.env.JWT_ACCESS_EXPIRY ?? '15m' },
    );

    const newTokenId = crypto.randomUUID();
    const refreshToken = fastify.jwt.sign(
      { sub: user.id, tokenId: newTokenId },
      { expiresIn: process.env.JWT_REFRESH_EXPIRY ?? '7d' },
    );

    await fastify.redis.set(
      `refresh:${user.id}:${newTokenId}`,
      '1',
      'EX',
      REFRESH_EXPIRY_SECONDS,
    );

    reply
      .setCookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/auth',
        maxAge: REFRESH_EXPIRY_SECONDS,
      })
      .code(200)
      .send({ accessToken });
  });

  fastify.post('/auth/logout', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const token = request.cookies.refreshToken;
    if (token) {
      try {
        const payload = fastify.jwt.verify<{ sub: string; tokenId: string }>(token);
        await fastify.redis.del(`refresh:${payload.sub}:${payload.tokenId}`);
      } catch {
        // Token already invalid — clear cookie anyway
      }
    }

    reply
      .clearCookie('refreshToken', { path: '/auth' })
      .code(200)
      .send({ status: 'logged_out' });
  });
}
