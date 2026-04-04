import fp from 'fastify-plugin';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { FastifyInstance } from 'fastify';

const softDeleteModels = ['User', 'Output'] as const;

function withSoftDelete(prisma: PrismaClient) {
  return prisma.$extends({
    query: {
      $allModels: {
        async findMany({ model, args, query }) {
          if (softDeleteModels.includes(model as any)) {
            args.where = { ...args.where, deletedAt: null };
          }
          return query(args);
        },
        async findFirst({ model, args, query }) {
          if (softDeleteModels.includes(model as any)) {
            args.where = { ...args.where, deletedAt: null };
          }
          return query(args);
        },
        async findUnique({ model, args, query }) {
          if (softDeleteModels.includes(model as any)) {
            args.where = { ...args.where, deletedAt: null } as any;
          }
          return query(args);
        },
        async count({ model, args, query }) {
          if (softDeleteModels.includes(model as any)) {
            args.where = { ...args.where, deletedAt: null };
          }
          return query(args);
        },
        async update({ model, args, query }) {
          if (softDeleteModels.includes(model as any)) {
            args.where = { ...args.where, deletedAt: null } as any;
          }
          return query(args);
        },
      },
    },
  });
}

export type ExtendedPrismaClient = ReturnType<typeof withSoftDelete>;

export default fp(async (fastify: FastifyInstance) => {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const prisma = withSoftDelete(new PrismaClient({ adapter }));
  fastify.decorate('prisma', prisma);
  fastify.addHook('onClose', async () => {
    await (prisma as any).$disconnect();
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    prisma: ExtendedPrismaClient;
  }
}
