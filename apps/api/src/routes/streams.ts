import type { FastifyInstance } from 'fastify';
import { sendCommand } from '../lib/sqs.js';

export default async function streamsRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/streams/active', async (request) => {
    const userId = request.user.sub;

    const sessions = await fastify.prisma.streamSession.findMany({
      where: {
        userId,
        status: { in: ['STARTING', 'LIVE'] },
      },
      include: { outputSessions: true },
      orderBy: { startedAt: 'desc' },
    });

    // Enrich with Redis metrics
    return Promise.all(
      sessions.map(async (session) => {
        try {
          const metricsRaw = await fastify.redis.get(`stream:${session.id}:bitrate`);
          const metrics = metricsRaw ? JSON.parse(metricsRaw) : null;
          return { ...session, metrics };
        } catch (err) {
          fastify.log.warn({ sessionId: session.id, err }, 'Failed to fetch Redis metrics');
          return { ...session, metrics: null };
        }
      }),
    );
  });

  fastify.post<{ Params: { outputSessionId: string } }>(
    '/streams/:outputSessionId/stop',
    async (request, reply) => {
      const userId = request.user.sub;
      const { outputSessionId } = request.params;

      const outputSession = await fastify.prisma.outputSession.findUnique({
        where: { id: outputSessionId },
        include: { session: true },
      });

      if (!outputSession || outputSession.session.userId !== userId) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'OUTPUT_SESSION_NOT_FOUND',
          message: 'Output session not found',
        });
      }

      await fastify.prisma.outputSession.update({
        where: { id: outputSessionId },
        data: { status: 'STOPPED', endedAt: new Date() },
      });

      await sendCommand({
        type: 'stop',
        userId,
        sessionId: outputSession.sessionId,
        outputSessionId,
      });

      return { status: 'stopped' };
    },
  );
}
