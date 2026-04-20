import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { isAdmin } from '../plugins/auth.js';

const SALT_ROUNDS = 12;
const ACCESS_EXPIRY_SECONDS = 15 * 60; // 15 minutes
const REFRESH_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

const IS_PROD = process.env.NODE_ENV === 'production';

// Set to the parent domain (e.g. `sruth.live`) so cookies set by the API on
// api.sruth.live are also sent to sruth.live — the Next.js middleware reads
// the accessToken from the incoming request to gate /dashboard. Without this,
// the cookie is host-locked to api.sruth.live and the web app sees no token.
// Unset in dev so cookies stay host-scoped to localhost.
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;

const ACCESS_COOKIE_OPTS = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: 'strict' as const,
  path: '/',
  maxAge: ACCESS_EXPIRY_SECONDS,
  domain: COOKIE_DOMAIN,
};

const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: 'strict' as const,
  path: '/auth',
  maxAge: REFRESH_EXPIRY_SECONDS,
  domain: COOKIE_DOMAIN,
};

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
      { expiresIn: ACCESS_EXPIRY_SECONDS },
    );

    const tokenId = crypto.randomUUID();
    const refreshToken = fastify.jwt.sign(
      { sub: user.id, tokenId },
      { expiresIn: process.env.JWT_REFRESH_EXPIRY ?? '7d' },
    );

    await fastify.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenId,
        expiresAt: new Date(Date.now() + REFRESH_EXPIRY_SECONDS * 1000),
      },
    });

    reply
      .setCookie('accessToken', accessToken, ACCESS_COOKIE_OPTS)
      .setCookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTS)
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
      { expiresIn: ACCESS_EXPIRY_SECONDS },
    );

    const tokenId = crypto.randomUUID();
    const refreshToken = fastify.jwt.sign(
      { sub: user.id, tokenId },
      { expiresIn: process.env.JWT_REFRESH_EXPIRY ?? '7d' },
    );

    await fastify.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenId,
        expiresAt: new Date(Date.now() + REFRESH_EXPIRY_SECONDS * 1000),
      },
    });

    reply
      .setCookie('accessToken', accessToken, ACCESS_COOKIE_OPTS)
      .setCookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTS)
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

    // Check token exists in DB (not revoked)
    const existing = await fastify.prisma.refreshToken.findUnique({
      where: { tokenId: payload.tokenId },
    });
    if (!existing || existing.expiresAt < new Date()) {
      return reply.code(401).send({
        statusCode: 401,
        error: 'REVOKED_REFRESH_TOKEN',
        message: 'Refresh token has been revoked',
      });
    }

    // Revoke old token
    await fastify.prisma.refreshToken.delete({
      where: { tokenId: payload.tokenId },
    });

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
      { expiresIn: ACCESS_EXPIRY_SECONDS },
    );

    const newTokenId = crypto.randomUUID();
    const refreshToken = fastify.jwt.sign(
      { sub: user.id, tokenId: newTokenId },
      { expiresIn: process.env.JWT_REFRESH_EXPIRY ?? '7d' },
    );

    await fastify.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenId: newTokenId,
        expiresAt: new Date(Date.now() + REFRESH_EXPIRY_SECONDS * 1000),
      },
    });

    reply
      .setCookie('accessToken', accessToken, ACCESS_COOKIE_OPTS)
      .setCookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTS)
      .code(200)
      .send({ accessToken });
  });

  fastify.get('/auth/me', { onRequest: [fastify.authenticate] }, async (request) => ({
    id: request.user.sub,
    email: request.user.email,
    isAdmin: isAdmin(request.user.email),
  }));

  fastify.post('/auth/logout', async (request, reply) => {
    const token = request.cookies.refreshToken;
    if (token) {
      try {
        const payload = fastify.jwt.verify<{ sub: string; tokenId: string }>(token);
        await fastify.prisma.refreshToken.delete({
          where: { tokenId: payload.tokenId },
        }).catch(() => {});
      } catch {
        // Token already invalid — clear cookie anyway
      }
    }

    // Browsers key cookies on (name, domain, path) — the clear directive has
    // to match the original scope or the cookie stays put.
    reply
      .clearCookie('accessToken', { path: ACCESS_COOKIE_OPTS.path, domain: COOKIE_DOMAIN })
      .clearCookie('refreshToken', { path: REFRESH_COOKIE_OPTS.path, domain: COOKIE_DOMAIN })
      .code(200)
      .send({ status: 'logged_out' });
  });
}
