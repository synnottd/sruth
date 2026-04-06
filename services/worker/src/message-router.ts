import type { WorkerCommand } from '@omega-stream/shared';
import { getRedis, getSubscriber } from './redis.js';

const HEARTBEAT_TTL = 30; // seconds
const HEARTBEAT_INTERVAL = 10_000; // ms
const SESSION_OWNER_TTL = 120; // seconds

export type CommandHandler = (command: WorkerCommand) => Promise<void>;

/**
 * Manages worker identity, heartbeat, session ownership,
 * and cross-worker message routing via Redis pub/sub.
 */
export class MessageRouter {
  private workerId: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private handler: CommandHandler | null = null;

  constructor(workerId: string) {
    this.workerId = workerId;
  }

  /** Start heartbeat and subscribe to this worker's pub/sub channel. */
  async start(handler: CommandHandler): Promise<void> {
    this.handler = handler;

    // Initial heartbeat
    await this.writeHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.writeHeartbeat().catch((err) =>
        console.error('[Router] Heartbeat write failed:', err),
      );
    }, HEARTBEAT_INTERVAL);

    // Subscribe to this worker's command channel for re-routed messages
    const sub = getSubscriber();
    const channel = this.channelKey();
    await sub.subscribe(channel);
    sub.on('message', (ch: string, message: string) => {
      if (ch !== channel) return;
      try {
        const command = JSON.parse(message) as WorkerCommand;
        this.handler?.(command).catch((err) =>
          console.error('[Router] Handler error from pub/sub:', err),
        );
      } catch (err) {
        console.error('[Router] Failed to parse pub/sub message:', err);
      }
    });

    console.log('[Router] Started, workerId:', this.workerId);
  }

  /** Stop heartbeat and unsubscribe. */
  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      const sub = getSubscriber();
      await sub.unsubscribe(this.channelKey());
    } catch {
      // Ignore unsubscribe errors during shutdown
    }
    // Clean up heartbeat key
    try {
      await getRedis().del(this.heartbeatKey());
    } catch {
      // Best effort
    }
    console.log('[Router] Stopped');
  }

  /** Register this worker as owner of a session. */
  async registerSession(sessionId: string): Promise<void> {
    await getRedis().set(
      this.sessionOwnerKey(sessionId),
      this.workerId,
      'EX',
      SESSION_OWNER_TTL,
    );
  }

  /** Refresh the session owner TTL (called during health flush). */
  async refreshSessionOwnership(sessionId: string): Promise<void> {
    await getRedis().expire(this.sessionOwnerKey(sessionId), SESSION_OWNER_TTL);
  }

  /** Remove session ownership on stop. */
  async unregisterSession(sessionId: string): Promise<void> {
    await getRedis().del(this.sessionOwnerKey(sessionId));
  }

  /**
   * Route a command to the correct worker.
   * Returns true if this worker should handle it, false if re-routed or dropped.
   */
  async routeCommand(command: WorkerCommand): Promise<boolean> {
    // For 'start' commands, this worker always handles it (and registers ownership)
    if (command.type === 'start') {
      return true;
    }

    const redis = getRedis();
    const ownerKey = this.sessionOwnerKey(command.sessionId);
    const ownerId = await redis.get(ownerKey);

    // This worker owns it
    if (ownerId === this.workerId) {
      return true;
    }

    // No owner registered — check if it's an orphan
    if (!ownerId) {
      // For stop commands on orphaned sessions, just confirm cleanup
      if (command.type === 'stop') {
        console.log('[Router] Session', command.sessionId, 'has no owner, confirming stop');
        return false;
      }
      // For update/relocate on orphaned sessions, drop — session is gone
      console.log('[Router] Session', command.sessionId, 'has no owner, dropping', command.type);
      return false;
    }

    // Owned by another worker — check if that worker is still alive
    const heartbeat = await redis.get(this.heartbeatKeyFor(ownerId));

    if (heartbeat) {
      // Owner is alive — re-route via pub/sub
      console.log('[Router] Re-routing', command.type, 'for session', command.sessionId, 'to worker', ownerId);
      await redis.publish(
        this.channelKeyFor(ownerId),
        JSON.stringify(command),
      );
      return false;
    }

    // Owner's heartbeat expired — it's dead
    if (command.type === 'stop') {
      // Clean up orphaned session ownership
      console.log('[Router] Owner', ownerId, 'is dead, cleaning up session', command.sessionId);
      await redis.del(ownerKey);
      return false;
    }

    // For update/relocate on dead owner, drop
    console.log('[Router] Owner', ownerId, 'is dead, dropping', command.type, 'for session', command.sessionId);
    await redis.del(ownerKey);
    return false;
  }

  getWorkerId(): string {
    return this.workerId;
  }

  // --- Key helpers ---

  private heartbeatKey(): string {
    return `worker:${this.workerId}:heartbeat`;
  }

  private heartbeatKeyFor(id: string): string {
    return `worker:${id}:heartbeat`;
  }

  private channelKey(): string {
    return `worker:${this.workerId}:commands`;
  }

  private channelKeyFor(id: string): string {
    return `worker:${id}:commands`;
  }

  private sessionOwnerKey(sessionId: string): string {
    return `session:${sessionId}:worker`;
  }

  private async writeHeartbeat(): Promise<void> {
    await getRedis().set(this.heartbeatKey(), '1', 'EX', HEARTBEAT_TTL);
  }
}
