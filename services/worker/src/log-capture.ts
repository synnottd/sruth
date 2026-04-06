import { getRedis } from './redis.js';
import { config } from './config.js';

const REDIS_LOG_MAX_LINES = 200;
const REDIS_LOG_TTL = 300; // 5 minutes
const CW_FLUSH_INTERVAL = 5_000; // 5s
const CW_FLUSH_LINES = 50;
const CW_LOG_GROUP = '/omega-stream/worker/ffmpeg';

// --- CloudWatch Logs abstraction ---

export interface CloudWatchLogsPublisher {
  putLogEvents(
    logGroup: string,
    logStream: string,
    events: Array<{ timestamp: number; message: string }>,
  ): Promise<void>;
}

export class AwsCloudWatchLogsPublisher implements CloudWatchLogsPublisher {
  private client: import('@aws-sdk/client-cloudwatch-logs').CloudWatchLogsClient | null = null;
  private sequenceTokens: Map<string, string | undefined> = new Map();

  private async getClient(): Promise<import('@aws-sdk/client-cloudwatch-logs').CloudWatchLogsClient> {
    if (!this.client) {
      const { CloudWatchLogsClient } = await import('@aws-sdk/client-cloudwatch-logs');
      this.client = new CloudWatchLogsClient({});
    }
    return this.client;
  }

  async putLogEvents(
    logGroup: string,
    logStream: string,
    events: Array<{ timestamp: number; message: string }>,
  ): Promise<void> {
    const { PutLogEventsCommand, CreateLogStreamCommand } = await import(
      '@aws-sdk/client-cloudwatch-logs'
    );
    const client = await this.getClient();
    const key = `${logGroup}:${logStream}`;

    try {
      const resp = await client.send(
        new PutLogEventsCommand({
          logGroupName: logGroup,
          logStreamName: logStream,
          logEvents: events,
          sequenceToken: this.sequenceTokens.get(key),
        }),
      );
      this.sequenceTokens.set(key, resp.nextSequenceToken);
    } catch (err: unknown) {
      // If the log stream doesn't exist, create it and retry
      if (err && typeof err === 'object' && 'name' in err && err.name === 'ResourceNotFoundException') {
        try {
          await client.send(
            new CreateLogStreamCommand({
              logGroupName: logGroup,
              logStreamName: logStream,
            }),
          );
        } catch {
          // Stream may already exist from a race
        }
        const resp = await client.send(
          new PutLogEventsCommand({
            logGroupName: logGroup,
            logStreamName: logStream,
            logEvents: events,
          }),
        );
        this.sequenceTokens.set(key, resp.nextSequenceToken);
      } else {
        throw err;
      }
    }
  }
}

export class NoopCloudWatchLogsPublisher implements CloudWatchLogsPublisher {
  async putLogEvents(): Promise<void> {
    // Silently drop in local dev
  }
}

export function createCloudWatchLogsPublisher(): CloudWatchLogsPublisher {
  if (config.localDev) {
    return new NoopCloudWatchLogsPublisher();
  }
  return new AwsCloudWatchLogsPublisher();
}

// --- Log buffer per output ---

interface OutputLogBuffer {
  sessionId: string;
  outputSessionId: string;
  lines: Array<{ timestamp: number; message: string }>;
}

/**
 * Captures FFmpeg stderr and dual-writes to Redis (real-time tail) and CloudWatch Logs (persistent).
 */
export class LogCapture {
  private buffers: Map<string, OutputLogBuffer> = new Map(); // keyed by outputSessionId
  private cwPublisher: CloudWatchLogsPublisher;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(cwPublisher: CloudWatchLogsPublisher) {
    this.cwPublisher = cwPublisher;
  }

  start(): void {
    this.flushTimer = setInterval(() => {
      this.flushAllToCloudWatch().catch((err) =>
        console.error('[LogCapture] CloudWatch flush error:', err),
      );
    }, CW_FLUSH_INTERVAL);
    console.log('[LogCapture] Started');
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush
    this.flushAllToCloudWatch().catch(() => {});
    this.buffers.clear();
    console.log('[LogCapture] Stopped');
  }

  /** Called for each FFmpeg stderr line. */
  async captureLine(sessionId: string, outputSessionId: string, line: string): Promise<void> {
    // Write to Redis immediately
    await this.writeToRedis(sessionId, outputSessionId, line);

    // Buffer for CloudWatch
    let buf = this.buffers.get(outputSessionId);
    if (!buf) {
      buf = { sessionId, outputSessionId, lines: [] };
      this.buffers.set(outputSessionId, buf);
    }
    buf.lines.push({ timestamp: Date.now(), message: line });

    // Flush to CloudWatch if buffer is full
    if (buf.lines.length >= CW_FLUSH_LINES) {
      await this.flushBufferToCloudWatch(buf);
    }
  }

  /** Remove buffers for a stopped output. */
  async removeOutput(outputSessionId: string): Promise<void> {
    const buf = this.buffers.get(outputSessionId);
    if (buf && buf.lines.length > 0) {
      await this.flushBufferToCloudWatch(buf);
    }
    this.buffers.delete(outputSessionId);
  }

  private async writeToRedis(sessionId: string, outputSessionId: string, line: string): Promise<void> {
    const key = `stream:${sessionId}:logs:${outputSessionId}`;
    const redis = getRedis();
    const pipeline = redis.pipeline();
    pipeline.lpush(key, line);
    pipeline.ltrim(key, 0, REDIS_LOG_MAX_LINES - 1);
    pipeline.expire(key, REDIS_LOG_TTL);
    await pipeline.exec();
  }

  private async flushAllToCloudWatch(): Promise<void> {
    for (const buf of this.buffers.values()) {
      if (buf.lines.length > 0) {
        await this.flushBufferToCloudWatch(buf);
      }
    }
  }

  private async flushBufferToCloudWatch(buf: OutputLogBuffer): Promise<void> {
    const events = buf.lines.splice(0); // Take all and clear
    if (events.length === 0) return;

    const logStream = `${buf.sessionId}/${buf.outputSessionId}`;
    try {
      await this.cwPublisher.putLogEvents(CW_LOG_GROUP, logStream, events);
    } catch (err) {
      console.error('[LogCapture] CloudWatch put failed for', logStream, err);
    }
  }
}
