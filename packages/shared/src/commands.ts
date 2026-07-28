/** Commands sent from the API to the Worker via Postgres queue */

export type WorkerCommandType = 'start' | 'stop';

type BaseCommand = {
  type: WorkerCommandType;
  userId: string;
  sessionId: string;
};

export type StartCommand = BaseCommand & {
  type: 'start';
  outputSessionId?: string; // omit for full-session start; present for single-output start
};

export type StopCommand = BaseCommand & {
  type: 'stop';
  outputSessionId?: string; // omit to stop all outputs for the session
};

export type WorkerCommand = StartCommand | StopCommand;
