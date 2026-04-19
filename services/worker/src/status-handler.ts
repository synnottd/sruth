import type { PrismaClient } from '@prisma/client';
import type { OutputStatus } from './ffmpeg-manager.js';

export interface StatusHandlerDeps {
  prisma: PrismaClient;
  onSse: (sessionId: string, outputSessionId: string, status: OutputStatus, error: string | null) => void;
  /** Max DB update attempts for a single status change (default 3). */
  maxRetries?: number;
  /** Delay between retries, in ms (default 500). */
  retryDelayMs?: number;
}

export interface StatusHandler {
  onStatusChange: (sessionId: string, outputSessionId: string, status: OutputStatus, error: string | null) => void;
  /** Resolve once all enqueued DB updates have completed (or given up). */
  flush(): Promise<void>;
}

interface PendingUpdate {
  sessionId: string;
  outputSessionId: string;
  status: OutputStatus;
  error: string | null;
}

/**
 * Status-change handler that serializes DB writes through an internal queue
 * with retry. Previously these updates were fire-and-forget: a transient DB
 * failure (connection blip, pool exhaustion) would silently drop the status
 * update and leave `recoverSessions()` reading stale state on restart.
 */
export function createStatusHandler(deps: StatusHandlerDeps): StatusHandler {
  const { prisma, onSse } = deps;
  const maxRetries = deps.maxRetries ?? 3;
  const retryDelayMs = deps.retryDelayMs ?? 500;

  const queue: PendingUpdate[] = [];
  let draining: Promise<void> | null = null;

  function dbStatusFor(status: OutputStatus): 'LIVE' | 'ERROR' | null {
    if (status === 'live') return 'LIVE';
    if (status === 'error') return 'ERROR';
    return null;
  }

  async function applyUpdate(update: PendingUpdate): Promise<void> {
    const dbStatus = dbStatusFor(update.status);
    if (!dbStatus) return;

    let attempt = 0;
    while (true) {
      attempt++;
      try {
        await prisma.outputSession.update({
          where: { id: update.outputSessionId },
          data: {
            status: dbStatus,
            lastError: update.error,
          },
        });
        if (update.status === 'live') {
          await prisma.streamSession.updateMany({
            where: { id: update.sessionId, status: 'STARTING' },
            data: { status: 'LIVE' },
          });
        }
        return;
      } catch (err) {
        if (attempt >= maxRetries) {
          console.error(
            '[StatusHandler] DB update for',
            update.outputSessionId,
            'failed after',
            attempt,
            'attempts; giving up:',
            err,
          );
          return;
        }
        console.warn(
          '[StatusHandler] DB update for',
          update.outputSessionId,
          'attempt',
          attempt,
          'failed; retrying:',
          err,
        );
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const next = queue.shift()!;
      await applyUpdate(next);
    }
  }

  function enqueue(update: PendingUpdate): void {
    queue.push(update);
    if (!draining) {
      draining = drain().finally(() => { draining = null; });
    }
  }

  return {
    onStatusChange(sessionId, outputSessionId, status, error) {
      console.log('[Worker] Status:', sessionId, outputSessionId, status, error ?? '');
      onSse(sessionId, outputSessionId, status, error);
      enqueue({ sessionId, outputSessionId, status, error });
    },
    async flush() {
      while (draining) {
        await draining;
      }
    },
  };
}
