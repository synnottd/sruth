import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkerCommand } from '@omega-stream/shared';

// Mock the SQS client before importing the consumer
const mockSend = vi.fn();
vi.mock('@aws-sdk/client-sqs', () => {
  return {
    SQSClient: class {
      send = mockSend;
    },
    ReceiveMessageCommand: class {
      _type = 'receive';
      params: unknown;
      constructor(params: unknown) { this.params = params; }
    },
    DeleteMessageCommand: class {
      _type = 'delete';
      params: unknown;
      constructor(params: unknown) { this.params = params; }
    },
  };
});

import { SqsConsumer } from '../sqs-consumer.js';

function makeMessage(command: WorkerCommand, receiptHandle = 'receipt-1') {
  return {
    Body: JSON.stringify(command),
    ReceiptHandle: receiptHandle,
  };
}

const startCommand: WorkerCommand = {
  type: 'start',
  userId: 'user-1',
  sessionId: 'session-1',
  ingestIp: '10.0.1.1',
  streamKey: 'key-1',
  outputs: [
    { outputSessionId: 'out-1', rtmpUrl: 'rtmp://twitch.tv/app', streamKey: 'live_xxx' },
  ],
};

const stopCommand: WorkerCommand = {
  type: 'stop',
  userId: 'user-1',
  sessionId: 'session-1',
};

describe('SqsConsumer', () => {
  let consumer: SqsConsumer;

  beforeEach(() => {
    vi.clearAllMocks();
    consumer = new SqsConsumer();
  });

  it('processes valid messages and deletes them', async () => {
    const handler = vi.fn<(cmd: WorkerCommand) => Promise<void>>().mockResolvedValue(undefined);

    // First poll returns a message, second poll triggers stop
    let pollCount = 0;
    mockSend.mockImplementation(async (cmd: { _type: string }) => {
      if (cmd._type === 'receive') {
        pollCount++;
        if (pollCount === 1) {
          return { Messages: [makeMessage(startCommand)] };
        }
        // Stop after first batch
        await consumer.stop();
        return { Messages: [] };
      }
      // DeleteMessageCommand
      return {};
    });

    await consumer.start(handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(startCommand);
    // One receive + one delete + one more receive (that triggers stop)
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('drops unparseable messages and deletes them', async () => {
    const handler = vi.fn<(cmd: WorkerCommand) => Promise<void>>();

    let pollCount = 0;
    mockSend.mockImplementation(async (cmd: { _type: string }) => {
      if (cmd._type === 'receive') {
        pollCount++;
        if (pollCount === 1) {
          return { Messages: [{ Body: 'not json', ReceiptHandle: 'r-bad' }] };
        }
        await consumer.stop();
        return { Messages: [] };
      }
      return {};
    });

    await consumer.start(handler);

    expect(handler).not.toHaveBeenCalled();
    // Receive + delete (bad msg) + receive (stop)
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('drops messages with invalid type and deletes them', async () => {
    const handler = vi.fn<(cmd: WorkerCommand) => Promise<void>>();

    let pollCount = 0;
    mockSend.mockImplementation(async (cmd: { _type: string }) => {
      if (cmd._type === 'receive') {
        pollCount++;
        if (pollCount === 1) {
          return {
            Messages: [{
              Body: JSON.stringify({ type: 'bogus', sessionId: 's', userId: 'u' }),
              ReceiptHandle: 'r-bad',
            }],
          };
        }
        await consumer.stop();
        return { Messages: [] };
      }
      return {};
    });

    await consumer.start(handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not delete message when handler throws', async () => {
    const handler = vi.fn<(cmd: WorkerCommand) => Promise<void>>()
      .mockRejectedValue(new Error('boom'));

    let pollCount = 0;
    mockSend.mockImplementation(async (cmd: { _type: string }) => {
      if (cmd._type === 'receive') {
        pollCount++;
        if (pollCount === 1) {
          return { Messages: [makeMessage(stopCommand)] };
        }
        await consumer.stop();
        return { Messages: [] };
      }
      return {};
    });

    await consumer.start(handler);

    expect(handler).toHaveBeenCalledTimes(1);
    // Receive + receive(stop) — no delete because handler threw
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('drops start command missing outputs', async () => {
    const handler = vi.fn<(cmd: WorkerCommand) => Promise<void>>();

    let pollCount = 0;
    mockSend.mockImplementation(async (cmd: { _type: string }) => {
      if (cmd._type === 'receive') {
        pollCount++;
        if (pollCount === 1) {
          return {
            Messages: [{
              Body: JSON.stringify({ type: 'start', sessionId: 's', userId: 'u', ingestIp: '1.2.3.4', streamKey: 'k' }),
              ReceiptHandle: 'r-bad',
            }],
          };
        }
        await consumer.stop();
        return { Messages: [] };
      }
      return {};
    });

    await consumer.start(handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it('drops ingest_relocated command missing newIngestIp', async () => {
    const handler = vi.fn<(cmd: WorkerCommand) => Promise<void>>();

    let pollCount = 0;
    mockSend.mockImplementation(async (cmd: { _type: string }) => {
      if (cmd._type === 'receive') {
        pollCount++;
        if (pollCount === 1) {
          return {
            Messages: [{
              Body: JSON.stringify({ type: 'ingest_relocated', sessionId: 's', userId: 'u' }),
              ReceiptHandle: 'r-bad',
            }],
          };
        }
        await consumer.stop();
        return { Messages: [] };
      }
      return {};
    });

    await consumer.start(handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it('drops update command with empty outputs', async () => {
    const handler = vi.fn<(cmd: WorkerCommand) => Promise<void>>();

    let pollCount = 0;
    mockSend.mockImplementation(async (cmd: { _type: string }) => {
      if (cmd._type === 'receive') {
        pollCount++;
        if (pollCount === 1) {
          return {
            Messages: [{
              Body: JSON.stringify({ type: 'update', sessionId: 's', userId: 'u', outputs: [] }),
              ReceiptHandle: 'r-bad',
            }],
          };
        }
        await consumer.stop();
        return { Messages: [] };
      }
      return {};
    });

    await consumer.start(handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it('processes multiple messages in a batch sequentially', async () => {
    const order: string[] = [];
    const handler = vi.fn<(cmd: WorkerCommand) => Promise<void>>()
      .mockImplementation(async (cmd) => {
        order.push(cmd.type);
      });

    let pollCount = 0;
    mockSend.mockImplementation(async (cmd: { _type: string }) => {
      if (cmd._type === 'receive') {
        pollCount++;
        if (pollCount === 1) {
          return {
            Messages: [
              makeMessage(startCommand, 'r1'),
              makeMessage(stopCommand, 'r2'),
            ],
          };
        }
        await consumer.stop();
        return { Messages: [] };
      }
      return {};
    });

    await consumer.start(handler);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['start', 'stop']);
  });
});
