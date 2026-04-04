import fp from 'fastify-plugin';
import Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';

export default fp(async (fastify: FastifyInstance) => {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  fastify.decorate('redis', redis);
  fastify.addHook('onClose', async () => {
    redis.disconnect();
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}
