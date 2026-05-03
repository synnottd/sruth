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
    // Atomically claim the oldest PENDING command by flipping it to CLAIMED.
    // At-most-once semantics: the row is reserved to this handler run; if
    // the process crashes mid-handler the row stays CLAIMED and the orphan
    // reaper flips it to FAILED after the stale window. Handlers are not
    // idempotent (full-session stop overwrites endedAt), so replay is unsafe.
    //
    // FOR UPDATE SKIP LOCKED serialises concurrent claims cleanly against
    // future multi-consumer scenarios.
    const rows = await this.prisma.$queryRaw<Array<{ id: string; payload: unknown }>>`
      UPDATE "WorkerCommand"
      SET status = 'CLAIMED', "claimedAt" = now()
      WHERE id = (
        SELECT id FROM "WorkerCommand"
        WHERE status = 'PENDING'
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, payload
    `;

    if (rows.length === 0) return;

    const { id, payload } = rows[0];
    const command = payload as WorkerCommand;

    // Run the handler and the settle update with separate error handling so
    // a transient DB error on the settle can't be misattributed as a handler
    // failure. If the settle fails the row stays CLAIMED and the reaper will
    // mark it orphaned after the stale window.
    let handlerError: unknown;
    try {
      await handler(command);
    } catch (err) {
      handlerError = err;
      console.error(
        '[CommandConsumer] Handler failed — marking FAILED:',
        command.type,
        command.sessionId,
        err,
      );
    }

    try {
      if (handlerError) {
        const lastError =
          handlerError instanceof Error ? handlerError.message : String(handlerError);
        await this.prisma.$executeRaw`
          UPDATE "WorkerCommand"
          SET status = 'FAILED', "completedAt" = now(), "lastError" = ${lastError}
          WHERE id = ${id} AND status = 'CLAIMED'
        `;
      } else {
        await this.prisma.$executeRaw`
          UPDATE "WorkerCommand"
          SET status = 'DONE', "completedAt" = now()
          WHERE id = ${id} AND status = 'CLAIMED'
        `;
      }
    } catch (settleErr) {
      console.error(
        '[CommandConsumer] Settle update failed — row stays CLAIMED for reaper:',
        id,
        settleErr,
      );
    }
  }
}
