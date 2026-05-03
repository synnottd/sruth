import type { FastifyInstance } from 'fastify';
import { Platform } from '@prisma/client';
import { z } from 'zod';
import { sendCommand } from '../lib/commands.js';

const MAX_OUTPUTS = 5;

const createOutputSchema = z.object({
  name: z.string().min(1).max(100),
  platform: z.nativeEnum(Platform),
  rtmpUrl: z.string().url().max(2048),
  streamKey: z.string().min(1).max(512),
});

const updateOutputSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  rtmpUrl: z.string().url().max(2048).optional(),
  streamKey: z.string().min(1).max(512).optional(),
  enabled: z.boolean().optional(),
});

function maskStreamKey(output: Record<string, unknown>) {
  const key = output.streamKey as string;
  const { streamKey: _, ...rest } = output;
  return { ...rest, streamKey: key.length > 4 ? key.slice(0, 4) + '****' : '****' };
}

export default async function outputRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/outputs', async (request) => {
    const userId = request.user.sub;
    const outputs = await fastify.prisma.output.findMany({ where: { userId } });
    return outputs.map(maskStreamKey);
  });

  fastify.post('/outputs', async (request, reply) => {
    const parsed = createOutputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'VALIDATION_ERROR',
        message: parsed.error.issues[0].message,
      });
    }

    const userId = request.user.sub;
    const { name, platform, rtmpUrl, streamKey } = parsed.data;

    const count = await fastify.prisma.output.count({ where: { userId } });
    if (count >= MAX_OUTPUTS) {
      return reply.code(422).send({
        statusCode: 422,
        error: 'MAX_OUTPUTS_REACHED',
        message: `Maximum of ${MAX_OUTPUTS} outputs allowed`,
      });
    }

    const output = await fastify.prisma.output.create({
      data: { userId, name, platform, rtmpUrl, streamKey },
    });

    return reply.code(201).send(maskStreamKey(output));
  });

  fastify.put<{
    Params: { id: string };
  }>('/outputs/:id', async (request, reply) => {
    const parsed = updateOutputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'VALIDATION_ERROR',
        message: parsed.error.issues[0].message,
      });
    }

    const userId = request.user.sub;
    const { id } = request.params;
    const { name, rtmpUrl, streamKey, enabled } = parsed.data;

    const existing = await fastify.prisma.output.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'OUTPUT_NOT_FOUND',
        message: 'Output not found',
      });
    }

    const enabledChanged = enabled !== undefined && enabled !== existing.enabled;

    const updated = await fastify.prisma.$transaction(async (tx) => {
      const u = await tx.output.update({
        where: { id },
        data: {
          ...(name !== undefined && { name }),
          ...(rtmpUrl !== undefined && { rtmpUrl }),
          ...(streamKey !== undefined && { streamKey }),
          ...(enabled !== undefined && { enabled }),
        },
      });

      if (!enabledChanged) return u;

      const activeSession = await tx.streamSession.findFirst({
        where: { userId, status: { in: ['STARTING', 'LIVE'] } },
      });
      if (!activeSession) return u;

      const existingOs = await tx.outputSession.findUnique({
        where: { sessionId_outputId: { sessionId: activeSession.id, outputId: id } },
      });

      if (enabled === false) {
        if (existingOs && (existingOs.status === 'STARTING' || existingOs.status === 'LIVE' || existingOs.status === 'RETRYING')) {
          await sendCommand(tx, {
            type: 'stop',
            userId,
            sessionId: activeSession.id,
            outputSessionId: existingOs.id,
          });
        }
        return u;
      }

      let os = existingOs;
      if (!os) {
        os = await tx.outputSession.create({
          data: { sessionId: activeSession.id, outputId: id, status: 'STARTING' },
        });
      } else if (os.status === 'STOPPED' || os.status === 'ERROR') {
        os = await tx.outputSession.update({
          where: { id: os.id },
          data: { status: 'STARTING', lastError: null, endedAt: null, reconnectCount: 0 },
        });
      } else {
        return u;
      }
      await sendCommand(tx, {
        type: 'start',
        userId,
        sessionId: activeSession.id,
        outputSessionId: os.id,
      });
      return u;
    });

    return maskStreamKey(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/outputs/:id', async (request, reply) => {
    const userId = request.user.sub;
    const { id } = request.params;

    const existing = await fastify.prisma.output.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'OUTPUT_NOT_FOUND',
        message: 'Output not found',
      });
    }

    await fastify.prisma.output.delete({ where: { id } });

    return reply.code(204).send();
  });
}
