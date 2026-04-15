import type { PrismaClient } from '@prisma/client';
import type { WorkerCommand } from '@sruth/shared';

export async function sendCommand(prisma: PrismaClient, command: WorkerCommand): Promise<void> {
  await prisma.workerCommand.create({ data: { payload: command as any } });
}
