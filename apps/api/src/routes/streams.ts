import type { FastifyInstance } from 'fastify';
import { sendCommand } from '../lib/commands.js';

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:4000';

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

    return sessions;
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

      await sendCommand(fastify.prisma, {
        type: 'stop',
        userId,
        sessionId: outputSession.sessionId,
        outputSessionId,
      });

      return { status: 'stopped' };
    },
  );

  // SSE proxy — pipe worker's SSE stream to the browser with auth
  fastify.get('/streams/live', async (request, reply) => {
    const userId = request.user.sub;

    try {
      const resp = await fetch(`${WORKER_URL}/streams/live/${userId}`);
      if (!resp.ok || !resp.body) {
        return reply.code(503).send({ error: 'Worker unavailable' });
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const reader = resp.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            reply.raw.write(value);
          }
        } catch {
          // Connection closed
        }
        reply.raw.end();
      };

      request.raw.on('close', () => {
        reader.cancel().catch(() => {});
      });

      pump();
      return reply;
    } catch {
      return reply.code(503).send({ error: 'Worker unavailable' });
    }
  });
}
