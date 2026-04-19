import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { FfmpegManager, OutputStatus } from './ffmpeg-manager.js';
import type { LogCapture } from './log-capture.js';
import type { ProgressMetrics } from './progress-parser.js';

interface SseConnection {
  reply: FastifyReply;
  userId: string;
}

export interface WorkerHttpOptions {
  /** Shared secret required on `/streams/live/:userId`. Omit to disable the check (dev only). */
  internalSecret?: string;
}

export class WorkerHttpServer {
  private app: FastifyInstance;
  private connections: Map<string, Set<SseConnection>> = new Map(); // userId -> connections
  private ffmpeg: FfmpegManager;
  private logs: LogCapture;
  private internalSecret?: string;

  constructor(ffmpeg: FfmpegManager, logs: LogCapture, opts: WorkerHttpOptions = {}) {
    this.ffmpeg = ffmpeg;
    this.logs = logs;
    this.internalSecret = opts.internalSecret;

    this.app = Fastify({ logger: false });

    this.app.get('/health', async () => ({ status: 'ok' }));

    this.app.get<{ Params: { userId: string } }>(
      '/streams/live/:userId',
      async (request, reply) => {
        // The SSE stream leaks per-user metrics + FFmpeg stderr (which can
        // contain upstream RTMP URLs). The worker listens on the Docker
        // internal network, but network boundaries have a way of slipping —
        // gate the endpoint on the same shared secret the API uses for
        // /internal/*. The API proxy forwards the header on behalf of the
        // authenticated browser session.
        if (this.internalSecret) {
          if (request.headers['x-internal-secret'] !== this.internalSecret) {
            return reply.code(403).send({ error: 'Forbidden' });
          }
        }

        const { userId } = request.params;

        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const conn: SseConnection = { reply, userId };

        let conns = this.connections.get(userId);
        if (!conns) {
          conns = new Set();
          this.connections.set(userId, conns);
        }
        conns.add(conn);

        // Send snapshot of current state
        this.sendSnapshot(conn);

        // Keep alive
        const keepAlive = setInterval(() => {
          reply.raw.write(':keepalive\n\n');
        }, 15_000);

        request.raw.on('close', () => {
          clearInterval(keepAlive);
          conns!.delete(conn);
          if (conns!.size === 0) {
            this.connections.delete(userId);
          }
        });

        // Don't resolve — keep the connection open
        return reply;
      },
    );
  }

  async start(port: number): Promise<void> {
    await this.app.listen({ port, host: '0.0.0.0' });
    console.log(`[HTTP] Worker server listening on port ${port}`);
  }

  async stop(): Promise<void> {
    // Close all SSE connections
    for (const conns of this.connections.values()) {
      for (const conn of conns) {
        conn.reply.raw.end();
      }
    }
    this.connections.clear();
    await this.app.close();
    console.log('[HTTP] Worker server stopped');
  }

  /** Push a status change event to connected clients. */
  pushStatus(userId: string, sessionId: string, outputSessionId: string, status: OutputStatus, error: string | null): void {
    this.sendEvent(userId, 'status', {
      sessionId,
      outputSessionId,
      status,
      error,
    });
  }

  /** Push metrics to connected clients. */
  pushMetrics(userId: string, sessionId: string, outputSessionId: string, metrics: ProgressMetrics): void {
    this.sendEvent(userId, 'metrics', {
      sessionId,
      outputSessionId,
      bitrate: metrics.bitrate,
      dropFrames: metrics.dropFrames,
      speed: metrics.speed,
    });
  }

  /** Push a log line to connected clients. */
  pushLog(userId: string, sessionId: string, outputSessionId: string, line: string): void {
    this.sendEvent(userId, 'log', {
      sessionId,
      outputSessionId,
      line,
    });
  }

  private sendSnapshot(conn: SseConnection): void {
    const sessions = this.ffmpeg.getSessions();
    const snapshot: any[] = [];

    for (const session of sessions.values()) {
      if (session.userId !== conn.userId) continue;

      const outputs: any[] = [];
      for (const output of session.outputs.values()) {
        outputs.push({
          outputSessionId: output.outputSessionId,
          status: output.status,
          lastError: output.lastError,
          lastMetrics: output.lastMetrics,
          recentLogs: this.logs.getBuffer(output.outputSessionId),
        });
      }

      snapshot.push({
        sessionId: session.sessionId,
        outputs,
      });
    }

    this.writeSse(conn, 'snapshot', { sessions: snapshot });
  }

  private sendEvent(userId: string, event: string, data: any): void {
    const conns = this.connections.get(userId);
    if (!conns || conns.size === 0) return;

    for (const conn of conns) {
      this.writeSse(conn, event, data);
    }
  }

  private writeSse(conn: SseConnection, event: string, data: any): void {
    try {
      conn.reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Connection may be closed
    }
  }
}
