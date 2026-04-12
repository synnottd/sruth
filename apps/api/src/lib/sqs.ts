import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqsClientConfig, type WorkerCommand } from '@omega-stream/shared';

const QUEUE_URL = process.env.SQS_QUEUE_URL;
const sqs = QUEUE_URL
  ? new SQSClient(sqsClientConfig(process.env.SQS_ENDPOINT, process.env.AWS_REGION))
  : null;

export async function sendCommand(command: WorkerCommand): Promise<void> {
  // Per-output stops include outputSessionId to avoid colliding with
  // full session stops — both use type 'stop' but need distinct dedup IDs
  // within SQS's 5-minute deduplication window.
  const suffix = command.type === 'stop' && command.outputSessionId
    ? `${command.outputSessionId}-stop`
    : command.type;
  const deduplicationId = `${command.sessionId}-${suffix}`;
  if (!sqs || !QUEUE_URL) {
    console.log('[SQS] No queue configured, logging command:', JSON.stringify(command));
    return;
  }
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(command),
      MessageGroupId: command.userId,
      MessageDeduplicationId: deduplicationId,
    }),
  );
}
