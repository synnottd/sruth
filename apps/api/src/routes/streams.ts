import type { FastifyInstance } from 'fastify';
import { sendCommand } from '../lib/commands.js';

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:4000';
const WORKER_CONNECT_TIMEOUT_MS = 5_000;

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

    const internalSecret = process.env.INTERNAL_SECRET;
    if (!internalSecret) {
      request.log.warn('INTERNAL_SECRET not configured — refusing to proxy SSE');
      return reply.code(500).send({ error: 'SSE proxy misconfigured' });
    }

    // Single AbortController drives both the connect-timeout and the
    // client-disconnect forwarding. Without this, a hung worker (TCP accept
    // but no HTTP response) would leave this handler blocked on `fetch`
    // forever, pinning the browser socket.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WORKER_CONNECT_TIMEOUT_MS);
    const onClientClose = () => controller.abort();
    request.raw.once('close', onClientClose);

    try {
      const resp = await fetch(`${WORKER_URL}/streams/live/${userId}`, {
        headers: { 'x-internal-secret': internalSecret },
        signal: controller.signal,
      });
      // Connect succeeded — the timeout is no longer relevant; the
      // client-close handler continues to forward into the stream.
      clearTimeout(timeout);

      if (!resp.ok || !resp.body) {
        request.raw.removeListener('close', onClientClose);
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
          // Stream closed (client disconnect, upstream abort, or error).
        } finally {
          reply.raw.end();
          request.raw.removeListener('close', onClientClose);
        }
      };

      pump().catch((err) => request.log.error({ err }, 'SSE pump error'));
      return reply;
    } catch {
      clearTimeout(timeout);
      request.raw.removeListener('close', onClientClose);
      return reply.code(503).send({ error: 'Worker unavailable' });
    }
  });
}
