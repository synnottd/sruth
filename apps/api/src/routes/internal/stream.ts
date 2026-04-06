import type { FastifyInstance } from 'fastify';
import { sendCommand } from '../../lib/sqs.js';

const ACTIVE_TTL = 6 * 60 * 60; // 6 hours
const COOLDOWN_TTL = 3; // 3 seconds

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

    // 2. Check cooldown
    const cooldown = await fastify.redis.exists(`stream:${streamKey}:cooldown`);
    if (cooldown) {
      return reply.code(429).send({
        statusCode: 429,
        error: 'COOLDOWN',
        message: 'Reconnecting too fast, wait a few seconds',
      });
    }

    // 3. Check existing active session
    const existingSessionId = await fastify.redis.get(`stream:${streamKey}:active`);
    if (existingSessionId) {
      const existingIp = await fastify.redis.get(`stream:${streamKey}:ingest_ip`);

      if (existingIp === clientIp) {
        // Same IP = genuine duplicate
        return reply.code(409).send({
          statusCode: 409,
          error: 'DUPLICATE_STREAM',
          message: 'Stream is already active from this IP',
        });
      }

      // Different IP = ingest failover
      await fastify.redis.set(`stream:${streamKey}:ingest_ip`, clientIp, 'EX', ACTIVE_TTL);
      await sendCommand({
        type: 'ingest_relocated',
        userId: user.id,
        sessionId: existingSessionId,
        newIngestIp: clientIp,
      });
      return reply.code(200).send({ status: 'relocated' });
    }

    // 4. Create StreamSession + OutputSessions in a transaction
    const outputs = await fastify.prisma.output.findMany({
      where: { userId: user.id, enabled: true },
    });

    const { session, outputSessions } = await fastify.prisma.$transaction(async (tx) => {
      const session = await tx.streamSession.create({
        data: { userId: user.id },
      });
      const outputSessions = await Promise.all(
        outputs.map((output) =>
          tx.outputSession.create({
            data: { sessionId: session.id, outputId: output.id },
          }),
        ),
      );
      return { session, outputSessions };
    });

    // 5. Atomically claim the active slot — if another request won, roll back
    const claimed = await fastify.redis.set(
      `stream:${streamKey}:active`, session.id, 'EX', ACTIVE_TTL, 'NX',
    );
    if (!claimed) {
      await fastify.prisma.outputSession.deleteMany({ where: { sessionId: session.id } });
      await fastify.prisma.streamSession.delete({ where: { id: session.id } });
      return reply.code(409).send({
        statusCode: 409,
        error: 'DUPLICATE_STREAM',
        message: 'Stream became active during processing',
      });
    }

    // 6. Set remaining Redis keys + cooldown (after successful claim)
    await fastify.redis.set(`stream:${streamKey}:ingest_ip`, clientIp, 'EX', ACTIVE_TTL);
    await fastify.redis.set(`stream:${streamKey}:cooldown`, '1', 'EX', COOLDOWN_TTL);

    // 9. Send SQS start command — if this fails, roll back so the user can retry
    const outputMap = new Map(outputs.map((o) => [o.id, o]));
    try {
      await sendCommand({
        type: 'start',
        userId: user.id,
        sessionId: session.id,
        ingestIp: clientIp,
        streamKey,
        outputs: outputSessions.map((os) => {
          const output = outputMap.get(os.outputId)!;
          return {
            outputSessionId: os.id,
            rtmpUrl: output.rtmpUrl,
            streamKey: output.streamKey,
          };
        }),
      });
    } catch {
      // Roll back Redis + DB so the user isn't stuck with a phantom session
      await fastify.redis.del(`stream:${streamKey}:active`);
      await fastify.redis.del(`stream:${streamKey}:ingest_ip`);
      await fastify.prisma.outputSession.deleteMany({ where: { sessionId: session.id } });
      await fastify.prisma.streamSession.delete({ where: { id: session.id } });
      return reply.code(503).send({
        statusCode: 503,
        error: 'WORKER_UNAVAILABLE',
        message: 'Failed to notify worker — stream rejected, please retry',
      });
    }

    // 10. Return 200
    return reply.code(200).send({ status: 'ok' });
  });

  fastify.post<{
    Body: { app: string; name: string };
  }>('/internal/stream/on-publish-done', async (request, reply) => {
    const streamKey = request.body.name;

    // Find active session
    const sessionId = await fastify.redis.get(`stream:${streamKey}:active`);
    if (!sessionId) {
      return reply.code(200).send({ status: 'no_active_session' });
    }

    // 1. Mark StreamSession as STOPPED
    const session = await fastify.prisma.streamSession.update({
      where: { id: sessionId },
      data: { status: 'STOPPED', endedAt: new Date() },
    });

    // 2. Mark all OutputSessions as STOPPED
    await fastify.prisma.outputSession.updateMany({
      where: { sessionId },
      data: { status: 'STOPPED', endedAt: new Date() },
    });

    // 3. Send SQS stop command
    await sendCommand({
      type: 'stop',
      userId: session.userId,
      sessionId,
    });

    // 4. Delete Redis keys
    await fastify.redis.del(`stream:${streamKey}:active`);
    await fastify.redis.del(`stream:${streamKey}:ingest_ip`);

    return reply.code(200).send({ status: 'ok' });
  });
}
