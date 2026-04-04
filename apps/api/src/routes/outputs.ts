import type { FastifyInstance } from 'fastify';

const MAX_OUTPUTS = 5;

export default async function outputRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/outputs', async (request) => {
    const userId = request.user.sub;
    return fastify.prisma.output.findMany({ where: { userId } });
  });

  fastify.post<{
    Body: {
      name: string;
      platform: 'TWITCH' | 'YOUTUBE' | 'FACEBOOK' | 'CUSTOM';
      rtmpUrl: string;
      streamKey: string;
    };
  }>('/outputs', async (request, reply) => {
    const userId = request.user.sub;
    const { name, platform, rtmpUrl, streamKey } = request.body;

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
    Body: { name?: string; rtmpUrl?: string; streamKey?: string; enabled?: boolean };
  }>('/outputs/:id', async (request, reply) => {
    const userId = request.user.sub;
    const { id } = request.params;
    const { name, rtmpUrl, streamKey, enabled } = request.body;

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

    // Soft delete
    await (fastify.prisma as any).output.update({
      where: { id, deletedAt: undefined },
      data: { deletedAt: new Date() },
    });

    return reply.code(204).send();
  });
}
