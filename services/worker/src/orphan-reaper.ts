import type { PrismaClient } from '@prisma/client';

export interface ReaperOptions {
  /** How long a CLAIMED row may hold `claimedAt` before being considered orphaned. */
  staleAfterMs?: number;
  /** Poll interval for periodic sweeps. */
  intervalMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Flip CLAIMED rows whose `claimedAt` predates the stale window to FAILED.
 *
 * Uses `claimedAt` (not `createdAt`) so a row that sat PENDING for a long
 * time before being claimed is not treated as an orphan.
 */
export async function sweep(
  prisma: PrismaClient,
  options: Pick<ReaperOptions, 'staleAfterMs'> = {},
): Promise<void> {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const cutoff = new Date(Date.now() - staleAfterMs);

  await prisma.$executeRaw`
    UPDATE "WorkerCommand"
    SET status = 'FAILED',
        "completedAt" = now(),
        "lastError" = 'orphaned: worker crash'
    WHERE status = 'CLAIMED' AND "claimedAt" < ${cutoff}
  `;
}

export interface Reaper {
  stop(): void;
}

/**
 * Start a periodic reaper. Runs one sweep immediately so a fresh worker
 * startup settles any orphans from the previous crash before the consumer
 * begins polling.
 */
export function start(prisma: PrismaClient, options: ReaperOptions = {}): Reaper {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  void sweep(prisma, { staleAfterMs }).catch((err) => {
    console.error('[OrphanReaper] startup sweep failed:', err);
  });

  const timer = setInterval(() => {
    void sweep(prisma, { staleAfterMs }).catch((err) => {
      console.error('[OrphanReaper] periodic sweep failed:', err);
    });
  }, intervalMs);

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
