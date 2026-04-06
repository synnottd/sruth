import type { FastifyInstance } from 'fastify';
import { Platform } from '@prisma/client';
import { z } from 'zod';

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

export default async function outputRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/outputs', async (request) => {
    const userId = request.user.sub;
    return fastify.prisma.output.findMany({ where: { userId } });
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

    return reply.code(201).send(output);
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

    const updated = await fastify.prisma.output.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(rtmpUrl !== undefined && { rtmpUrl }),
        ...(streamKey !== undefined && { streamKey }),
        ...(enabled !== undefined && { enabled }),
      },
    });

    return updated;
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
