import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';

const INGEST_URL_BASE = process.env.INGEST_URL_BASE ?? 'rtmp://localhost:1935/live';
const INGEST_SRT_URL_BASE = process.env.INGEST_SRT_URL_BASE ?? 'srt://localhost:9999';

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
      srtIngestUrl: `${INGEST_SRT_URL_BASE}?streamid=publish:${user.streamKey}`,
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

    // Check if stream is live via DB
    const activeSession = await fastify.prisma.streamSession.findFirst({
      where: {
        userId,
        status: { in: ['STARTING', 'LIVE'] },
      },
    });
    if (activeSession) {
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
