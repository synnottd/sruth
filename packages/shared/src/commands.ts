/** Commands sent from the API to the Worker via Postgres queue */

export type WorkerCommandType = 'start' | 'stop';

interface BaseCommand {
  type: WorkerCommandType;
  userId: string;
  sessionId: string;
}

export interface StartCommand extends BaseCommand {
  type: 'start';
}

export interface StopCommand extends BaseCommand {
  type: 'stop';
  outputSessionId?: string; // omit to stop all outputs for the session
}

export type WorkerCommand = StartCommand | StopCommand;
