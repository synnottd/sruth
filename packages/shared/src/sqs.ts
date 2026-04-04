/** Commands sent from the API to the Worker via SQS FIFO */

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

export interface StartCommand extends BaseCommand {
  type: 'start';
  ingestIp: string;
  streamKey: string;
  outputs: Array<{
    outputSessionId: string;
    rtmpUrl: string;
    streamKey: string;
  }>;
}

export interface StopCommand extends BaseCommand {
  type: 'stop';
  outputSessionId?: string; // omit to stop all outputs for the session
}

export interface UpdateCommand extends BaseCommand {
  type: 'update';
  outputs: Array<{
    outputSessionId: string;
    rtmpUrl: string;
    streamKey: string;
  }>;
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
