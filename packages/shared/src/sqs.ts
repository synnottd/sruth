/** Commands sent from the API to the Worker via SQS FIFO */

/** Dummy AWS credentials for local dev with ElasticMQ. */
export const LOCAL_SQS_CREDENTIALS = {
  accessKeyId: 'local',
  secretAccessKey: 'local',
} as const;

/**
 * Build SQS client config for local dev (ElasticMQ) or production.
 * Pass the result to `new SQSClient(...)`.
 */
export function sqsClientConfig(endpoint?: string, region?: string) {
  if (!endpoint) return {};
  return {
    endpoint,
    region: region ?? 'us-east-1',
    credentials: LOCAL_SQS_CREDENTIALS,
  };
}

export type WorkerCommandType =
  | 'start'
  | 'stop'
  | 'update'
  | 'ingest_relocated';

interface BaseCommand {
  type: WorkerCommandType;
  userId: string;
  sessionId: string;
}

export interface OutputTarget {
  outputSessionId: string;
  rtmpUrl: string;
  streamKey: string;
}

export interface StartCommand extends BaseCommand {
  type: 'start';
  ingestIp: string;
  streamKey: string;
  outputs: OutputTarget[];
}

export interface StopCommand extends BaseCommand {
  type: 'stop';
  outputSessionId?: string; // omit to stop all outputs for the session
}

export interface UpdateCommand extends BaseCommand {
  type: 'update';
  outputs: OutputTarget[];
}

export interface IngestRelocatedCommand extends BaseCommand {
  type: 'ingest_relocated';
  newIngestIp: string;
}

export type WorkerCommand =
  | StartCommand
  | StopCommand
  | UpdateCommand
  | IngestRelocatedCommand;
