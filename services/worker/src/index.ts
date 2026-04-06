import type { WorkerCommand } from '@omega-stream/shared';
import { SqsConsumer } from './sqs-consumer.js';
import { MessageRouter } from './message-router.js';
import { FfmpegManager } from './ffmpeg-manager.js';
import { HealthReporter, createCloudWatchPublisher } from './health-reporter.js';
import { LogCapture, createCloudWatchLogsPublisher } from './log-capture.js';
import { resolveWorkerId } from './worker-identity.js';
import { shutdownRedis } from './redis.js';

const consumer = new SqsConsumer();
let router: MessageRouter;
let ffmpeg: FfmpegManager;
let health: HealthReporter;
let logs: LogCapture;

async function handleCommand(command: WorkerCommand): Promise<void> {
  console.log('[Worker] Command:', command.type, command.sessionId);

  switch (command.type) {
    case 'start': {
      await router.registerSession(command.sessionId);
      ffmpeg.startSession(
        command.sessionId,
        command.userId,
        command.streamKey,
        command.ingestIp,
        command.outputs,
      );
      break;
    }
    case 'stop': {
      if (command.outputSessionId) {
        await ffmpeg.stopSession(command.sessionId, command.outputSessionId);
        await logs.removeOutput(command.outputSessionId);
      } else {
        // Full session stop — collect output IDs before stopping (stopSession removes the session)
        const session = ffmpeg.getSession(command.sessionId);
        const outputIds = session ? Array.from(session.outputs.keys()) : [];
        await ffmpeg.stopSession(command.sessionId);
        for (const id of outputIds) {
          await logs.removeOutput(id);
        }
        await router.unregisterSession(command.sessionId);
      }
      break;
    }
    case 'update': {
      ffmpeg.addOutputs(command.sessionId, command.outputs);
      break;
    }
    case 'ingest_relocated': {
      await ffmpeg.relocateIngest(command.sessionId, command.newIngestIp);
      break;
    }
  }
}

/** SQS entry point — routes commands to the correct worker before handling. */
async function onSqsMessage(command: WorkerCommand): Promise<void> {
  const shouldHandle = await router.routeCommand(command);
  if (!shouldHandle) return;
  await handleCommand(command);
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[Worker] Received ${signal}, shutting down...`);

  // 1. Stop accepting new messages
  await consumer.stop();

  // 2. Stop health reporting (no more Redis/CW flushes)
  health.stop();
  logs.stop();

  // 3. Kill all FFmpeg processes
  await ffmpeg.shutdownAll();

  // 4. Stop router (heartbeat, pub/sub)
  await router.stop();

  // 5. Close Redis connections
  await shutdownRedis();

  process.exit(0);
}

async function main(): Promise<void> {
  const workerId = await resolveWorkerId();

  // Initialize components
  router = new MessageRouter(workerId);

  logs = new LogCapture(createCloudWatchLogsPublisher());

  ffmpeg = new FfmpegManager({
    onStatusChange: (sessionId, outputSessionId, status, error) => {
      console.log('[Worker] Status:', sessionId, outputSessionId, status, error ?? '');
      if (status === 'error') {
        health.reportError(sessionId, outputSessionId);
      } else {
        health.clearError(outputSessionId);
      }
    },
    onMetrics: (sessionId, outputSessionId, metrics) => {
      health.recordMetrics(sessionId, outputSessionId, metrics);
    },
    onStderrLine: (sessionId, outputSessionId, line) => {
      logs.captureLine(sessionId, outputSessionId, line).catch((err) =>
        console.error('[Worker] Log capture error:', err),
      );
    },
  });

  health = new HealthReporter(ffmpeg, router, createCloudWatchPublisher());

  // Start components
  await router.start(handleCommand);
  health.start();
  logs.start();

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log('[Worker] Ready, starting SQS consumer...');
  await consumer.start(onSqsMessage);
}

main().catch((err) => {
  console.error('[Worker] Fatal error:', err);
  process.exit(1);
});
