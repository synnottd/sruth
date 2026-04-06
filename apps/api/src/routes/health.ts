import type { FastifyInstance } from 'fastify';

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async (_request, reply) => {
    try {
      await Promise.all([
        fastify.prisma.$queryRawUnsafe('SELECT 1'),
        fastify.redis.ping(),
      ]);
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unhealthy' });
    }
  });
}
