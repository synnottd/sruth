export type Platform = 'twitch' | 'youtube' | 'facebook' | 'custom';

export type OutputSessionStatus = 'starting' | 'live' | 'error' | 'stopped';

export interface User {
  id: string;
  email: string;
  streamKey: string;
  tenantId: string | null;
  createdAt: Date;
}

export interface Output {
  id: string;
  userId: string;
  name: string;
  platform: Platform;
  rtmpUrl: string;
  streamKey: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface StreamSession {
  id: string;
  userId: string;
  startedAt: Date;
  endedAt: Date | null;
  avgBitrate: number | null;
  peakBitrate: number | null;
}

export interface OutputSession {
  id: string;
  sessionId: string;
  outputId: string;
  status: OutputSessionStatus;
  lastError: string | null;
  reconnectCount: number;
  startedAt: Date;
  endedAt: Date | null;
}

export interface StreamHealth {
  sessionId: string;
  outputId: string;
  bitrate: number;
  droppedFrames: number;
  reconnectCount: number;
  status: OutputSessionStatus;
  updatedAt: Date;
}
