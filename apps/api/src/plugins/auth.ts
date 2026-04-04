import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export default fp(async (fastify: FastifyInstance) => {
  await fastify.register(fastifyCookie);
  await fastify.register(fastifyJwt, {
    secret: process.env.JWT_SECRET ?? 'dev-secret',
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

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string };
    user: { sub: string; email: string };
  }
}
