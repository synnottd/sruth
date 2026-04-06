export type Platform = "TWITCH" | "YOUTUBE" | "FACEBOOK" | "CUSTOM";

export type OutputSessionStatus = "STARTING" | "LIVE" | "ERROR" | "STOPPED";
export type StreamSessionStatus = "STARTING" | "LIVE" | "ERROR" | "STOPPED";

export interface Output {
  id: string;
  name: string;
  platform: Platform;
  rtmpUrl: string;
  streamKey: string; // masked
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OutputSession {
  id: string;
  sessionId: string;
  outputId: string;
  status: OutputSessionStatus;
  lastError: string | null;
  reconnectCount: number;
  startedAt: string;
  endedAt: string | null;
}

export interface StreamSession {
  id: string;
  userId: string;
  status: StreamSessionStatus;
  startedAt: string;
  endedAt: string | null;
  avgBitrate: number | null;
  peakBitrate: number | null;
  outputSessions: OutputSession[];
  metrics: { bitrate: number } | null;
}

export interface StreamInfo {
  streamKey: string;
  ingestUrl: string;
}
