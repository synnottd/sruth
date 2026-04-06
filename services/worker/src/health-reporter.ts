import { getRedis } from './redis.js';
import type { MessageRouter } from './message-router.js';
import type { FfmpegManager, OutputStatus } from './ffmpeg-manager.js';
import type { ProgressMetrics } from './progress-parser.js';
import { config } from './config.js';

const REDIS_FLUSH_INTERVAL = 5_000; // 5s
const CLOUDWATCH_FLUSH_INTERVAL = 60_000; // 60s

// Redis key TTLs (seconds)
const BITRATE_TTL = 10;
const STATUS_TTL = 120;
const HEALTH_TTL = 30;

interface BitrateSample {
  value: number;
  timestamp: number;
}

/** Per-output accumulated samples between CloudWatch flushes. */
interface OutputSamples {
  bitrate: BitrateSample[];
}

/**
 * Periodically flushes stream health data to Redis and CloudWatch.
 */
export class HealthReporter {
  private ffmpeg: FfmpegManager;
  private router: MessageRouter;
  private redisTimer: ReturnType<typeof setInterval> | null = null;
  private cwTimer: ReturnType<typeof setInterval> | null = null;
  private cwPublisher: CloudWatchPublisher;

  // Accumulated bitrate samples per outputSessionId for CloudWatch aggregation
  private samples: Map<string, OutputSamples> = new Map();

  // Track when outputs entered error state: outputSessionId → { sessionId, enteredAt }
  private errorOutputs: Map<string, { sessionId: string; enteredAt: number }> = new Map();

  constructor(ffmpeg: FfmpegManager, router: MessageRouter, cwPublisher: CloudWatchPublisher) {
    this.ffmpeg = ffmpeg;
    this.router = router;
    this.cwPublisher = cwPublisher;
  }

  start(): void {
    this.redisTimer = setInterval(() => {
      this.flushToRedis().catch((err) =>
        console.error('[Health] Redis flush error:', err),
      );
    }, REDIS_FLUSH_INTERVAL);

    this.cwTimer = setInterval(() => {
      this.flushToCloudWatch().catch((err) =>
        console.error('[Health] CloudWatch flush error:', err),
      );
    }, CLOUDWATCH_FLUSH_INTERVAL);

    console.log('[Health] Reporter started');
  }

  stop(): void {
    if (this.redisTimer) {
      clearInterval(this.redisTimer);
      this.redisTimer = null;
    }
    if (this.cwTimer) {
      clearInterval(this.cwTimer);
      this.cwTimer = null;
    }
    this.samples.clear();
    console.log('[Health] Reporter stopped');
  }

  /** Called when an output enters error state. */
  reportError(sessionId: string, outputSessionId: string): void {
    if (!this.errorOutputs.has(outputSessionId)) {
      this.errorOutputs.set(outputSessionId, { sessionId, enteredAt: Date.now() });
    }
  }

  /** Called when an output leaves error state (e.g. stopped or recovered). */
  clearError(outputSessionId: string): void {
    this.errorOutputs.delete(outputSessionId);
  }

  /** Called by FfmpegManager on each progress metrics event. */
  recordMetrics(sessionId: string, outputSessionId: string, metrics: ProgressMetrics): void {
    if (metrics.bitrate !== null) {
      let outputSamples = this.samples.get(outputSessionId);
      if (!outputSamples) {
        outputSamples = { bitrate: [] };
        this.samples.set(outputSessionId, outputSamples);
      }
      outputSamples.bitrate.push({ value: metrics.bitrate, timestamp: Date.now() });
    }
  }

  /** Flush current state to Redis for all active sessions. */
  async flushToRedis(): Promise<void> {
    const redis = getRedis();
    const sessions = this.ffmpeg.getSessions();

    for (const session of sessions.values()) {
      const { sessionId } = session;

      // Refresh session ownership TTL
      await this.router.refreshSessionOwnership(sessionId).catch(() => {});

      // Collect per-output data
      const statusEntries: string[] = [];
      const healthEntries: string[] = [];
      let latestBitrate: number | null = null;

      for (const output of session.outputs.values()) {
        const { outputSessionId, status, lastMetrics } = output;

        // Status hash
        statusEntries.push(outputSessionId, status);

        // Health hash
        healthEntries.push(
          `${outputSessionId}:dropFrames`,
          String(lastMetrics?.dropFrames ?? 0),
          `${outputSessionId}:reconnectCount`,
          String(output.retryCount),
        );

        // Track latest bitrate across all outputs for the session-level key
        if (lastMetrics?.bitrate !== null && lastMetrics?.bitrate !== undefined) {
          if (latestBitrate === null || lastMetrics.bitrate > latestBitrate) {
            latestBitrate = lastMetrics.bitrate;
          }
        }
      }

      const pipeline = redis.pipeline();

      // Session-level bitrate (latest across all outputs)
      if (latestBitrate !== null) {
        pipeline.set(`stream:${sessionId}:bitrate`, String(latestBitrate), 'EX', BITRATE_TTL);
      }

      // Per-output status hash
      if (statusEntries.length > 0) {
        pipeline.del(`stream:${sessionId}:status`);
        pipeline.hset(`stream:${sessionId}:status`, ...statusEntries);
        pipeline.expire(`stream:${sessionId}:status`, STATUS_TTL);
      }

      // Per-output health hash
      if (healthEntries.length > 0) {
        pipeline.del(`stream:${sessionId}:health`);
        pipeline.hset(`stream:${sessionId}:health`, ...healthEntries);
        pipeline.expire(`stream:${sessionId}:health`, HEALTH_TTL);
      }

      await pipeline.exec();
    }
  }

  /** Flush accumulated bitrate samples to CloudWatch as StatisticValues. */
  async flushToCloudWatch(): Promise<void> {
    const sessions = this.ffmpeg.getSessions();
    const metricData: CloudWatchMetricDatum[] = [];

    for (const session of sessions.values()) {
      for (const output of session.outputs.values()) {
        const outputSamples = this.samples.get(output.outputSessionId);
        if (!outputSamples || outputSamples.bitrate.length === 0) continue;

        const values = outputSamples.bitrate.map((s) => s.value);
        const datum: CloudWatchMetricDatum = {
          metricName: 'Bitrate',
          dimensions: [
            { name: 'SessionId', value: session.sessionId },
            { name: 'OutputSessionId', value: output.outputSessionId },
          ],
          statisticValues: {
            minimum: Math.min(...values),
            maximum: Math.max(...values),
            sum: values.reduce((a, b) => a + b, 0),
            sampleCount: values.length,
          },
          unit: 'Kilobits/Second',
          timestamp: new Date(),
        };
        metricData.push(datum);

        // Clear samples after flush
        outputSamples.bitrate = [];
      }
    }

    // OutputErrorDuration: how long each output has been in error state (seconds)
    const now = Date.now();
    for (const [outputSessionId, { sessionId, enteredAt }] of this.errorOutputs) {
      const durationSeconds = (now - enteredAt) / 1000;
      metricData.push({
        metricName: 'OutputErrorDuration',
        dimensions: [
          { name: 'SessionId', value: sessionId },
          { name: 'OutputSessionId', value: outputSessionId },
        ],
        statisticValues: {
          minimum: durationSeconds,
          maximum: durationSeconds,
          sum: durationSeconds,
          sampleCount: 1,
        },
        unit: 'Seconds',
        timestamp: new Date(),
      });
    }

    if (metricData.length > 0) {
      await this.cwPublisher.putMetrics(metricData);
    }
  }
}

// --- CloudWatch abstraction ---

export interface CloudWatchDimension {
  name: string;
  value: string;
}

export interface CloudWatchStatisticValues {
  minimum: number;
  maximum: number;
  sum: number;
  sampleCount: number;
}

export interface CloudWatchMetricDatum {
  metricName: string;
  dimensions: CloudWatchDimension[];
  statisticValues: CloudWatchStatisticValues;
  unit: string;
  timestamp: Date;
}

export interface CloudWatchPublisher {
  putMetrics(data: CloudWatchMetricDatum[]): Promise<void>;
}

// --- Real CloudWatch implementation ---

export class AwsCloudWatchPublisher implements CloudWatchPublisher {
  private client: import('@aws-sdk/client-cloudwatch').CloudWatchClient | null = null;
  private namespace = 'OmegaStream/Worker';

  private async getClient(): Promise<import('@aws-sdk/client-cloudwatch').CloudWatchClient> {
    if (!this.client) {
      const { CloudWatchClient } = await import('@aws-sdk/client-cloudwatch');
      this.client = new CloudWatchClient({});
    }
    return this.client;
  }

  async putMetrics(data: CloudWatchMetricDatum[]): Promise<void> {
    const { PutMetricDataCommand } = await import('@aws-sdk/client-cloudwatch');
    const client = await this.getClient();

    // CloudWatch allows max 1000 metric data per call; batch in chunks of 25
    for (let i = 0; i < data.length; i += 25) {
      const batch = data.slice(i, i + 25);
      await client.send(
        new PutMetricDataCommand({
          Namespace: this.namespace,
          MetricData: batch.map((d) => ({
            MetricName: d.metricName,
            Dimensions: d.dimensions.map((dim) => ({
              Name: dim.name,
              Value: dim.value,
            })),
            StatisticValues: {
              Minimum: d.statisticValues.minimum,
              Maximum: d.statisticValues.maximum,
              Sum: d.statisticValues.sum,
              SampleCount: d.statisticValues.sampleCount,
            },
            Unit: d.unit as import('@aws-sdk/client-cloudwatch').StandardUnit,
            Timestamp: d.timestamp,
          })),
        }),
      );
    }
  }
}

// --- No-op implementation for local dev ---

export class NoopCloudWatchPublisher implements CloudWatchPublisher {
  async putMetrics(_data: CloudWatchMetricDatum[]): Promise<void> {
    // Silently drop in local dev
  }
}

export function createCloudWatchPublisher(): CloudWatchPublisher {
  if (config.localDev) {
    return new NoopCloudWatchPublisher();
  }
  return new AwsCloudWatchPublisher();
}
