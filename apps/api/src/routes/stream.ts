import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';

const INGEST_URL_BASE = process.env.INGEST_URL_BASE ?? 'rtmp://localhost:1935/live';

export default async function streamRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/stream', async (request, reply) => {
    const userId = request.user.sub;
    const user = await fastify.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }
    return {
      streamKey: user.streamKey,
      ingestUrl: `${INGEST_URL_BASE}/${user.streamKey}`,
    };
  });

  fastify.post('/stream/key/rotate', async (request, reply) => {
    const userId = request.user.sub;
    const user = await fastify.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    // Check if stream is live
    const active = await fastify.redis.exists(`stream:${user.streamKey}:active`);
    if (active) {
      return reply.code(409).send({
        statusCode: 409,
        error: 'STREAM_IS_LIVE',
        message: 'Cannot rotate stream key while streaming. Disconnect first.',
      });
    }

    const newStreamKey = crypto.randomUUID();
    await fastify.prisma.user.update({
      where: { id: userId },
      data: { streamKey: newStreamKey },
    });

    return { streamKey: newStreamKey };
  });
}
