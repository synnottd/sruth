import type { FastifyInstance } from 'fastify';
import type { ExtendedPrismaClient } from '../../plugins/prisma.js';
import { fetchPublishers, type Publisher } from '../../lib/mediamtx.js';

interface QueueFailure {
  id: string;
  type: string;
  sessionId: string | null;
  completedAt: string;
  lastError: string | null;
}

interface QueueSnapshot {
  pending: number;
  claimed: number;
  failed: number;
  oldestPendingAgeMs: number | null;
  recentFailures: QueueFailure[];
}

interface SessionOutput {
  outputId: string;
  name: string;
  platform: string;
  status: string;
  lastError: string | null;
}

interface SessionSnapshot {
  sessionId: string;
  userId: string;
  userEmail: string;
  status: 'STARTING' | 'LIVE' | 'ERROR';
  startedAt: string;
  outputs: SessionOutput[];
}

interface PublisherSnapshot extends Publisher {
  userEmail: string | null;
}

interface MediaMtxSnapshot {
  reachable: boolean;
  publishers: PublisherSnapshot[];
  byProtocol: { rtmp: number; srt: number };
}

export interface StatusSnapshot {
  queue: QueueSnapshot;
  sessions: SessionSnapshot[];
  mediamtx: MediaMtxSnapshot;
  generatedAt: string;
}

const MAX_RECENT_FAILURES = 10;

async function composeQueue(prisma: ExtendedPrismaClient): Promise<QueueSnapshot> {
  const [counts, oldestPending, failures] = await Promise.all([
    prisma.workerCommand.groupBy({
      by: ['status'],
      _count: { _all: true },
    }),
    prisma.workerCommand.findFirst({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.workerCommand.findMany({
      where: { status: 'FAILED' },
      orderBy: { completedAt: 'desc' },
      take: MAX_RECENT_FAILURES,
      select: {
        id: true,
        payload: true,
        completedAt: true,
        lastError: true,
      },
    }),
  ]);

  const countByStatus = new Map<string, number>();
  for (const row of counts) countByStatus.set(row.status, row._count._all);

  return {
    pending: countByStatus.get('PENDING') ?? 0,
    claimed: countByStatus.get('CLAIMED') ?? 0,
    failed: countByStatus.get('FAILED') ?? 0,
    oldestPendingAgeMs: oldestPending
      ? Date.now() - oldestPending.createdAt.getTime()
      : null,
    recentFailures: failures.map((f) => {
      const payload = (f.payload ?? {}) as { type?: string; sessionId?: string | null };
      return {
        id: f.id,
        type: payload.type ?? 'unknown',
        sessionId: payload.sessionId ?? null,
        completedAt: (f.completedAt ?? new Date()).toISOString(),
        lastError: f.lastError,
      };
    }),
  };
}

async function composeSessions(prisma: ExtendedPrismaClient): Promise<SessionSnapshot[]> {
  const sessions = await prisma.streamSession.findMany({
    where: { status: { in: ['STARTING', 'LIVE', 'ERROR'] } },
    include: {
      user: { select: { email: true } },
      outputSessions: {
        include: { output: { select: { name: true, platform: true } } },
      },
    },
    orderBy: { startedAt: 'desc' },
  });

  return sessions.map((s) => ({
    sessionId: s.id,
    userId: s.userId,
    userEmail: s.user.email,
    status: s.status as 'STARTING' | 'LIVE' | 'ERROR',
    startedAt: s.startedAt.toISOString(),
    outputs: s.outputSessions.map((os) => ({
      outputId: os.outputId,
      name: os.output.name,
      platform: os.output.platform,
      status: os.status,
      lastError: os.lastError,
    })),
  }));
}

async function composeMediaMtx(prisma: ExtendedPrismaClient): Promise<MediaMtxSnapshot> {
  const { reachable, publishers } = await fetchPublishers();
  if (!reachable || publishers.length === 0) {
    return {
      reachable,
      publishers: [],
      byProtocol: { rtmp: 0, srt: 0 },
    };
  }

  const keys = publishers.map((p) => p.streamKey);
  const users = await prisma.user.findMany({
    where: { streamKey: { in: keys } },
    select: { email: true, streamKey: true },
  });
  const emailByKey = new Map(users.map((u) => [u.streamKey, u.email]));

  const joined: PublisherSnapshot[] = publishers.map((p) => ({
    ...p,
    userEmail: emailByKey.get(p.streamKey) ?? null,
  }));

  const byProtocol = { rtmp: 0, srt: 0 };
  for (const p of joined) byProtocol[p.protocol] += 1;

  return { reachable: true, publishers: joined, byProtocol };
}

/** Compose the full status snapshot. Exported so the SSE route can reuse it. */
export async function buildSnapshot(prisma: ExtendedPrismaClient): Promise<StatusSnapshot> {
  const [queue, sessions, mediamtx] = await Promise.all([
    composeQueue(prisma),
    composeSessions(prisma),
    composeMediaMtx(prisma),
  ]);

  return { queue, sessions, mediamtx, generatedAt: new Date().toISOString() };
}

const SSE_INTERVAL_MS = 5_000;

export default async function adminStatusRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/admin/status/snapshot',
    { onRequest: [fastify.authenticateAdmin] },
    async () => buildSnapshot(fastify.prisma),
  );

  fastify.get(
    '/admin/status/stream',
    { onRequest: [fastify.authenticateAdmin] },
    async (request, reply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const write = async () => {
        try {
          const snapshot = await buildSnapshot(fastify.prisma);
          reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
        } catch (err) {
          request.log.error({ err }, 'admin status SSE snapshot failed');
        }
      };

      await write();
      const timer = setInterval(write, SSE_INTERVAL_MS);

      const cleanup = () => {
        clearInterval(timer);
        reply.raw.end();
      };
      request.raw.once('close', cleanup);

      return reply;
    },
  );
}
