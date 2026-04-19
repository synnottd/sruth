import type { FastifyInstance } from 'fastify';
import { sendCommand } from '../../lib/commands.js';

export default async function internalStreamRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: { app: string; name: string; addr?: string };
  }>('/internal/stream/on-publish', async (request, reply) => {
    const streamKey = request.body.name;
    const clientIp = request.body.addr ?? '';

    // 1. Look up stream key
    const user = await fastify.prisma.user.findFirst({
      where: { streamKey },
    });
    if (!user) {
      return reply.code(401).send({
        statusCode: 401,
        error: 'INVALID_STREAM_KEY',
        message: 'Stream key not found or disabled',
      });
    }

    // 2. Check for existing LIVE/STARTING session
    const existingSession = await fastify.prisma.streamSession.findFirst({
      where: {
        userId: user.id,
        status: { in: ['STARTING', 'LIVE'] },
      },
    });

    if (existingSession) {
      // Resume — FFmpeg is still running, no command needed
      // Update ingest IP if changed
      if (existingSession.ingestIp !== clientIp) {
        await fastify.prisma.streamSession.update({
          where: { id: existingSession.id },
          data: { ingestIp: clientIp },
        });
      }
      return reply.code(200).send({ status: 'resumed' });
    }

    // 3. Create StreamSession + OutputSessions + WorkerCommand in a transaction
    const outputs = await fastify.prisma.output.findMany({
      where: { userId: user.id, enabled: true, deletedAt: null },
    });

    try {
      await fastify.prisma.$transaction(async (tx) => {
        const session = await tx.streamSession.create({
          data: { userId: user.id, ingestIp: clientIp },
        });

        await Promise.all(
          outputs.map((output) =>
            tx.outputSession.create({
              data: { sessionId: session.id, outputId: output.id },
            }),
          ),
        );

        await tx.workerCommand.create({
          data: {
            payload: {
              type: 'start',
              userId: user.id,
              sessionId: session.id,
            },
          },
        });
      });
    } catch (err: any) {
      // Partial unique index violation = another request won the race
      if (err?.code === 'P2002') {
        return reply.code(409).send({
          statusCode: 409,
          error: 'DUPLICATE_STREAM',
          message: 'Stream became active during processing',
        });
      }
      throw err;
    }

    return reply.code(200).send({ status: 'ok' });
  });

  fastify.post<{
    Body: { app: string; name: string };
  }>('/internal/stream/on-unpublish', async (request, reply) => {
    const streamKey = request.body.name;

    const user = await fastify.prisma.user.findFirst({
      where: { streamKey },
    });
    if (!user) {
      return reply.code(200).send({ status: 'ignored' });
    }

    // Find active session for this user
    const session = await fastify.prisma.streamSession.findFirst({
      where: {
        userId: user.id,
        status: { in: ['STARTING', 'LIVE'] },
      },
    });

    if (!session) {
      return reply.code(200).send({ status: 'no-session' });
    }

    // Send stop command to worker
    await sendCommand(fastify.prisma, {
      type: 'stop',
      userId: user.id,
      sessionId: session.id,
    });

    return reply.code(200).send({ status: 'ok' });
  });
}
