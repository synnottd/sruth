import type { PrismaClient } from '@prisma/client';
import type { FfmpegManager, OutputStatus } from './ffmpeg-manager.js';
import type { ProgressMetrics } from './progress-parser.js';

interface BitrateSample {
  value: number;
  timestamp: number;
}

interface OutputSamples {
  bitrate: BitrateSample[];
}

export class HealthReporter {
  private ffmpeg: FfmpegManager;
  private prisma: PrismaClient;
  private samples: Map<string, OutputSamples> = new Map();

  constructor(ffmpeg: FfmpegManager, prisma: PrismaClient) {
    this.ffmpeg = ffmpeg;
    this.prisma = prisma;
  }

  start(): void {
    console.log('[Health] Reporter started');
  }

  stop(): void {
    this.samples.clear();
    console.log('[Health] Reporter stopped');
  }

  recordMetrics(_sessionId: string, outputSessionId: string, metrics: ProgressMetrics): void {
    if (metrics.bitrate !== null) {
      let outputSamples = this.samples.get(outputSessionId);
      if (!outputSamples) {
        outputSamples = { bitrate: [] };
        this.samples.set(outputSessionId, outputSamples);
      }
      outputSamples.bitrate.push({ value: metrics.bitrate, timestamp: Date.now() });
    }
  }

  /** Write summary metrics to StreamSession when a session ends. */
  async writeSummary(sessionId: string): Promise<void> {
    // Collect all bitrate samples across outputs for this session
    const session = this.ffmpeg.getSession(sessionId);
    if (!session) return;

    const allSamples: number[] = [];
    for (const output of session.outputs.values()) {
      const outputSamples = this.samples.get(output.outputSessionId);
      if (outputSamples) {
        allSamples.push(...outputSamples.bitrate.map((s) => s.value));
        this.samples.delete(output.outputSessionId);
      }
    }

    if (allSamples.length === 0) return;

    const avgBitrate = allSamples.reduce((a, b) => a + b, 0) / allSamples.length;
    const peakBitrate = Math.max(...allSamples);

    await this.prisma.streamSession.update({
      where: { id: sessionId },
      data: { avgBitrate, peakBitrate },
    });
  }

  /** Clean up samples for a specific output. */
  clearOutput(outputSessionId: string): void {
    this.samples.delete(outputSessionId);
  }
}
