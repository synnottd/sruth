import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { StopCommand, WorkerCommand } from '@sruth/shared';
import { CommandConsumer } from './command-consumer.js';
import { FfmpegManager } from './ffmpeg-manager.js';
import { HealthReporter } from './health-reporter.js';
import { LogCapture } from './log-capture.js';
import { WorkerHttpServer } from './http.js';
import { resolveWorkerId } from './worker-identity.js';
import { config } from './config.js';
import { createStatusHandler, type StatusHandler } from './status-handler.js';

const adapter = new PrismaPg(config.databaseUrl);
const prisma = new PrismaClient({ adapter });

let consumer: CommandConsumer;
let ffmpeg: FfmpegManager;
let health: HealthReporter;
let logs: LogCapture;
let http: WorkerHttpServer;
let statusHandler: StatusHandler;

async function handleStart(sessionId: string): Promise<void> {
  const session = await prisma.streamSession.findUnique({
    where: { id: sessionId },
    include: {
      user: true,
      outputSessions: {
        include: { output: true },
        where: { status: { not: 'STOPPED' } },
      },
    },
  });

  if (!session || session.status === 'STOPPED') {
    console.log('[Worker] Session not found or stopped:', sessionId);
    return;
  }

  const outputs = session.outputSessions.map((os) => ({
    outputSessionId: os.id,
    rtmpUrl: os.output.rtmpUrl,
    streamKey: os.output.streamKey,
  }));

  ffmpeg.startSession(
    session.id,
    session.userId,
    session.user.streamKey,
    session.ingestIp ?? 'ingest',
    outputs,
  );
}

async function handleStop(command: StopCommand): Promise<void> {
  if (command.outputSessionId) {
    await ffmpeg.stopSession(command.sessionId, command.outputSessionId);
    logs.removeOutput(command.outputSessionId);
    health.clearOutput(command.outputSessionId);

    await prisma.outputSession.update({
      where: { id: command.outputSessionId },
      data: { status: 'STOPPED', endedAt: new Date() },
    });
    return;
  }

  // Full session stop
  const session = ffmpeg.getSession(command.sessionId);
  const outputIds = session ? Array.from(session.outputs.keys()) : [];

  await health.writeSummary(command.sessionId);
  await ffmpeg.stopSession(command.sessionId);

  for (const id of outputIds) {
    logs.removeOutput(id);
    health.clearOutput(id);
  }

  await prisma.streamSession.update({
    where: { id: command.sessionId },
    data: { status: 'STOPPED', endedAt: new Date() },
  });
  await prisma.outputSession.updateMany({
    where: { sessionId: command.sessionId, status: { not: 'STOPPED' } },
    data: { status: 'STOPPED', endedAt: new Date() },
  });
}

async function markSessionError(sessionId: string): Promise<void> {
  try {
    await prisma.streamSession.updateMany({
      where: { id: sessionId, status: 'STARTING' },
      data: { status: 'ERROR' },
    });
  } catch (err) {
    console.error('[Worker] Failed to mark session ERROR:', sessionId, err);
  }
}

async function forceStopped(command: StopCommand): Promise<void> {
  const now = new Date();
  try {
    if (command.outputSessionId) {
      await prisma.outputSession.update({
        where: { id: command.outputSessionId },
        data: { status: 'STOPPED', endedAt: now },
      });
      return;
    }
    await prisma.$transaction([
      prisma.streamSession.updateMany({
        where: { id: command.sessionId, status: { not: 'STOPPED' } },
        data: { status: 'STOPPED', endedAt: now },
      }),
      prisma.outputSession.updateMany({
        where: { sessionId: command.sessionId, status: { not: 'STOPPED' } },
        data: { status: 'STOPPED', endedAt: now },
      }),
    ]);
  } catch (err) {
    console.error('[Worker] Failed to force STOPPED state:', command.sessionId, err);
  }
}

async function handleCommand(command: WorkerCommand): Promise<void> {
  console.log('[Worker] Command:', command.type, command.sessionId);

  switch (command.type) {
    case 'start': {
      try {
        await handleStart(command.sessionId);
      } catch (err) {
        console.error('[Worker] start failed; marking session ERROR:', command.sessionId, err);
        await markSessionError(command.sessionId);
      }
      break;
    }
    case 'stop': {
      try {
        await handleStop(command);
      } catch (err) {
        console.error('[Worker] stop failed; forcing STOPPED state:', command.sessionId, err);
        await forceStopped(command);
      }
      break;
    }
  }
}

/** Resume any LIVE/STARTING sessions on startup (crash recovery). */
async function recoverSessions(): Promise<void> {
  const activeSessions = await prisma.streamSession.findMany({
    where: { status: { in: ['STARTING', 'LIVE'] } },
    include: {
      user: true,
      outputSessions: {
        include: { output: true },
        where: { status: { not: 'STOPPED' } },
      },
    },
  });

  if (activeSessions.length === 0) {
    console.log('[Worker] No sessions to recover');
    return;
  }

  console.log('[Worker] Recovering', activeSessions.length, 'active session(s)');

  for (const session of activeSessions) {
    const outputs = session.outputSessions.map((os) => ({
      outputSessionId: os.id,
      rtmpUrl: os.output.rtmpUrl,
      streamKey: os.output.streamKey,
    }));

    if (outputs.length === 0) {
      // No outputs to resume — mark as stopped
      await prisma.streamSession.update({
        where: { id: session.id },
        data: { status: 'STOPPED', endedAt: new Date() },
      });
      continue;
    }

    ffmpeg.startSession(
      session.id,
      session.userId,
      session.user.streamKey,
      session.ingestIp ?? 'ingest',
      outputs,
    );
  }
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[Worker] Received ${signal}, shutting down...`);

  const hardTimeout = setTimeout(() => {
    console.error('[Worker] Shutdown timed out after 30s, forcing exit');
    process.exit(1);
  }, 30_000);
  hardTimeout.unref();

  try {
    await consumer.stop();
    await http.stop();
    health.stop();
    logs.stop();
    await ffmpeg.shutdownAll();
    await statusHandler.flush();
    await prisma.$disconnect();
  } catch (err) {
    console.error('[Worker] Error during shutdown:', err);
  }

  process.exit(0);
}

async function main(): Promise<void> {
  const workerId = resolveWorkerId();

  // In production the SSE endpoint must be gated — an unset secret means any
  // container on the Docker network could scrape another user's live logs.
  if (process.env.NODE_ENV === 'production' && !config.internalSecret) {
    console.error('[Worker] INTERNAL_SECRET is required when NODE_ENV=production');
    process.exit(1);
  }

  logs = new LogCapture();

  statusHandler = createStatusHandler({
    prisma,
    onSse: (sessionId, outputSessionId, status, error) => {
      const session = ffmpeg?.getSession(sessionId);
      if (session) {
        http.pushStatus(session.userId, sessionId, outputSessionId, status, error);
      }
    },
  });

  ffmpeg = new FfmpegManager({
    onStatusChange: statusHandler.onStatusChange,
    onMetrics: (sessionId, outputSessionId, metrics) => {
      health.recordMetrics(sessionId, outputSessionId, metrics);

      const session = ffmpeg.getSession(sessionId);
      if (session) {
        http.pushMetrics(session.userId, sessionId, outputSessionId, metrics);
      }
    },
    onStderrLine: (sessionId, outputSessionId, line) => {
      logs.captureLine(sessionId, outputSessionId, line);

      const session = ffmpeg.getSession(sessionId);
      if (session) {
        http.pushLog(session.userId, sessionId, outputSessionId, line);
      }
    },
  });

  health = new HealthReporter(ffmpeg, prisma);
  http = new WorkerHttpServer(ffmpeg, logs, { internalSecret: config.internalSecret });
  consumer = new CommandConsumer(prisma, config.pollIntervalMs);

  // Start components
  health.start();
  logs.start();
  await http.start(config.httpPort);

  // Recover active sessions before starting consumer
  await recoverSessions();

  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });

  console.log('[Worker] Ready, starting command consumer...');
  await consumer.start(handleCommand);
}

main().catch((err) => {
  console.error('[Worker] Fatal error:', err);
  process.exit(1);
});
