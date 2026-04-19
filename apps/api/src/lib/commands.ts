import type { WorkerCommand } from '@sruth/shared';
import type { ExtendedPrismaClient } from '../plugins/prisma.js';

export async function sendCommand(prisma: ExtendedPrismaClient, command: WorkerCommand): Promise<void> {
  await prisma.workerCommand.create({ data: { payload: command } });
}
