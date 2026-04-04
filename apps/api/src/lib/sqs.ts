import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { WorkerCommand } from '@omega-stream/shared';

const sqs = new SQSClient({});
const QUEUE_URL = process.env.SQS_QUEUE_URL ?? '';

export async function sendCommand(command: WorkerCommand): Promise<void> {
  const deduplicationId = `${command.sessionId}-${command.type}`;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(command),
      MessageGroupId: command.userId,
      MessageDeduplicationId: deduplicationId,
    }),
  );
}
