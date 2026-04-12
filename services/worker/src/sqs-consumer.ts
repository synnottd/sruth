import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import type { WorkerCommand } from '@omega-stream/shared';
import { config } from './config.js';

export type MessageHandler = (command: WorkerCommand) => Promise<void>;

const VALID_TYPES = new Set(['start', 'stop', 'update', 'ingest_relocated']);

function parseMessage(body: string): WorkerCommand | null {
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!VALID_TYPES.has(parsed.type) || typeof parsed.sessionId !== 'string' || typeof parsed.userId !== 'string') {
      console.warn('[SQS] Invalid message structure:', parsed.type, parsed.sessionId);
      return null;
    }

    // Validate command-specific required fields
    switch (parsed.type) {
      case 'start':
        if (typeof parsed.ingestIp !== 'string') return null;
        if (typeof parsed.streamKey !== 'string') return null;
        if (!Array.isArray(parsed.outputs) || parsed.outputs.length === 0) return null;
        break;
      case 'update':
        if (!Array.isArray(parsed.outputs) || parsed.outputs.length === 0) return null;
        break;
      case 'ingest_relocated':
        if (typeof parsed.newIngestIp !== 'string') return null;
        break;
      // 'stop' has no additional required fields
    }

    return parsed as WorkerCommand;
  } catch {
    console.warn('[SQS] Failed to parse message body:', body);
    return null;
  }
}

export class SqsConsumer {
  private sqs: SQSClient;
  private running = false;
  private inflightPromise: Promise<void> | null = null;

  constructor() {
    this.sqs = new SQSClient(
      config.sqsEndpoint ? { endpoint: config.sqsEndpoint } : {},
    );
  }

  async start(handler: MessageHandler): Promise<void> {
    this.running = true;
    console.log('[SQS] Consumer started, polling', config.sqsQueueUrl);

    while (this.running) {
      try {
        const resp = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: config.sqsQueueUrl,
            WaitTimeSeconds: config.sqsWaitTimeSeconds,
            MaxNumberOfMessages: config.sqsMaxMessages,
            VisibilityTimeout: config.sqsVisibilityTimeout,
          }),
        );

        if (!resp.Messages?.length) continue;

        for (const msg of resp.Messages) {
          if (!this.running) break;

          const command = parseMessage(msg.Body ?? '');
          if (!command) {
            console.warn('[SQS] Dropping unparseable message:', msg.Body);
            await this.deleteMessage(msg.ReceiptHandle!);
            continue;
          }

          this.inflightPromise = handler(command);
          try {
            await this.inflightPromise;
          } catch (err) {
            console.error('[SQS] Handler error for', command.type, command.sessionId, err);
            // Don't delete — let visibility timeout expire so it can be retried / DLQ'd
            continue;
          } finally {
            this.inflightPromise = null;
          }

          await this.deleteMessage(msg.ReceiptHandle!);
        }
      } catch (err) {
        if (!this.running) break;
        console.error('[SQS] Poll error:', err);
        // Brief pause before retrying to avoid tight error loop
        await sleep(1000);
      }
    }

    console.log('[SQS] Consumer stopped');
  }

  async stop(): Promise<void> {
    console.log('[SQS] Stopping consumer...');
    this.running = false;
    // Wait for any in-flight handler to finish
    if (this.inflightPromise) {
      console.log('[SQS] Waiting for in-flight handler...');
      await this.inflightPromise.catch(() => {});
    }
  }

  private async deleteMessage(receiptHandle: string): Promise<void> {
    try {
      await this.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: config.sqsQueueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
    } catch (err) {
      console.error('[SQS] Delete failed:', err);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
