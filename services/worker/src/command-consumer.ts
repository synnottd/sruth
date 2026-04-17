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
    // Atomically claim the oldest command: the DELETE ... RETURNING statement
    // removes the row from the queue in the same operation that hands it to
    // us. This gives at-most-once semantics — if the process crashes after
    // this statement but before/during handler execution, the command is lost
    // rather than replayed. Replay was unsafe because several handlers (e.g.
    // the full-session `stop` path in index.ts) are not idempotent and would
    // corrupt DB state on a second run (e.g. overwrite `endedAt`).
    //
    // FOR UPDATE SKIP LOCKED is belt-and-braces for any future multi-consumer
    // scenario; today we run a single worker, so the subquery would never
    // contend, but it costs nothing and makes the semantics explicit.
    const rows = await this.prisma.$queryRaw<Array<{ payload: unknown }>>`
      DELETE FROM "WorkerCommand"
      WHERE id = (
        SELECT id FROM "WorkerCommand"
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING payload
    `;

    if (rows.length === 0) return;

    const command = rows[0].payload as WorkerCommand;

    try {
      await handler(command);
    } catch (err) {
      // The command has already been removed from the queue. Log loudly so
      // operators notice; we do not replay because replay can corrupt state.
      console.error(
        '[CommandConsumer] Handler failed — command discarded:',
        command.type,
        command.sessionId,
        err,
      );
    }
  }
}
