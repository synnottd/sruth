import type { PrismaClient } from '@prisma/client';
import type { FfmpegManager } from './ffmpeg-manager.js';
import type { ProgressMetrics } from './progress-parser.js';

interface OutputAggregate {
  count: number;
  sum: number;
  peak: number;
}

export class HealthReporter {
  private ffmpeg: FfmpegManager;
  private prisma: PrismaClient;
  // Running aggregates per output — O(1) memory regardless of stream length.
  // We only ever surface avg and peak, so there is no reason to keep samples.
  private aggregates: Map<string, OutputAggregate> = new Map();

  constructor(ffmpeg: FfmpegManager, prisma: PrismaClient) {
    this.ffmpeg = ffmpeg;
    this.prisma = prisma;
  }

  start(): void {
    console.log('[Health] Reporter started');
  }

  stop(): void {
    this.aggregates.clear();
    console.log('[Health] Reporter stopped');
  }

  recordMetrics(_sessionId: string, outputSessionId: string, metrics: ProgressMetrics): void {
    if (metrics.bitrate === null) return;
    let agg = this.aggregates.get(outputSessionId);
    if (!agg) {
      agg = { count: 0, sum: 0, peak: 0 };
      this.aggregates.set(outputSessionId, agg);
    }
    agg.count++;
    agg.sum += metrics.bitrate;
    if (metrics.bitrate > agg.peak) agg.peak = metrics.bitrate;
  }

  /** Write summary metrics to StreamSession when a session ends. */
  async writeSummary(sessionId: string): Promise<void> {
    const session = this.ffmpeg.getSession(sessionId);
    if (!session) return;

    let totalCount = 0;
    let totalSum = 0;
    let peakBitrate = 0;
    for (const output of session.outputs.values()) {
      const agg = this.aggregates.get(output.outputSessionId);
      if (agg) {
        totalCount += agg.count;
        totalSum += agg.sum;
        if (agg.peak > peakBitrate) peakBitrate = agg.peak;
        this.aggregates.delete(output.outputSessionId);
      }
    }

    if (totalCount === 0) return;

    const avgBitrate = totalSum / totalCount;

    await this.prisma.streamSession.update({
      where: { id: sessionId },
      data: { avgBitrate, peakBitrate },
    });
  }

  /** Clean up aggregate for a specific output. */
  clearOutput(outputSessionId: string): void {
    this.aggregates.delete(outputSessionId);
  }
}
