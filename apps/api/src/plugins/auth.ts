import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export default fp(async (fastify: FastifyInstance) => {
  await fastify.register(fastifyCookie);
  await fastify.register(fastifyJwt, {
    secret: process.env.JWT_SECRET || (() => {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('JWT_SECRET must be set in production');
      }
      return 'dev-secret';
    })(),
    cookie: {
      cookieName: 'accessToken',
      signed: false,
    },
  });

  fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({
        statusCode: 401,
        error: 'UNAUTHORIZED',
        message: 'Invalid or expired token',
      });
    }
  });

  fastify.decorate('authenticateAdmin', async (request: FastifyRequest, reply: FastifyReply) => {
    await fastify.authenticate(request, reply);
    if (reply.sent) return;
    if (!isAdmin(request.user.email)) {
      return reply.code(403).send({
        statusCode: 403,
        error: 'FORBIDDEN',
        message: 'Admin only',
      });
    }
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Return true if `email` is in ADMIN_EMAILS. The env var is a comma-separated
 * list; we parse on each call so tests (and env reloads) see fresh values.
 * Entries are trimmed, lowercased, and empty pieces skipped so a stray space
 * or trailing comma in the deploy config doesn't silently lock an admin out.
 *
 * `email` accepts `undefined` defensively: the JWT `payload` type allows
 * `email?` even though `user` resolves it to a required string, so a malformed
 * token without an email claim must fail closed instead of throwing.
 */
export function isAdmin(email: string | undefined): boolean {
  if (!email) return false;
  const raw = process.env.ADMIN_EMAILS ?? '';
  const allowed = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return false;
  return allowed.includes(email.toLowerCase());
}

// Access tokens carry { sub, email }; refresh tokens carry { sub, tokenId }.
// Both are signed via the same fastify.jwt instance, so `payload` must accept
// either shape. `user` is what's decoded on request.jwtVerify() — which only
// runs on access-cookie routes, so it stays as the access-token shape.
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email?: string; tokenId?: string };
    user: { sub: string; email: string };
  }
}
