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
});

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
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
