import type { WorkerCommand } from '@sruth/shared';

interface CommandWriter {
  workerCommand: { create: (args: { data: { payload: WorkerCommand } }) => Promise<unknown> };
}

export async function sendCommand(client: CommandWriter, command: WorkerCommand): Promise<void> {
  await client.workerCommand.create({ data: { payload: command } });
}
