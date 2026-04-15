import type { PrismaClient } from '@prisma/client';
import type { WorkerCommand } from '@sruth/shared';

export type CommandHandler = (command: WorkerCommand) => Promise<void>;

export class CommandConsumer {
  private prisma: PrismaClient;
  private pollIntervalMs: number;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(prisma: PrismaClient, pollIntervalMs = 1000) {
    this.prisma = prisma;
    this.pollIntervalMs = pollIntervalMs;
  }

  async start(handler: CommandHandler): Promise<void> {
    this.running = true;
    console.log('[CommandConsumer] Started, polling every', this.pollIntervalMs, 'ms');
    this.poll(handler);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('[CommandConsumer] Stopped');
  }

  private poll(handler: CommandHandler): void {
    if (!this.running) return;

    this.processNext(handler)
      .catch((err) => console.error('[CommandConsumer] Poll error:', err))
      .finally(() => {
        if (this.running) {
          this.timer = setTimeout(() => this.poll(handler), this.pollIntervalMs);
        }
      });
  }

  private async processNext(handler: CommandHandler): Promise<void> {
    const row = await this.prisma.workerCommand.findFirst({
      orderBy: { createdAt: 'asc' },
    });

    if (!row) return;

    const command = row.payload as unknown as WorkerCommand;

    try {
      await handler(command);
      await this.prisma.workerCommand.delete({ where: { id: row.id } });
    } catch (err) {
      console.error('[CommandConsumer] Handler error for', command.type, command.sessionId, err);
      // Leave row for retry on next poll
    }
  }
}
