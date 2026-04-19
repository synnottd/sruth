import type { FastifyInstance } from 'fastify';

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async (_request, reply) => {
    try {
      await fastify.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unhealthy' });
    }
  });
}
