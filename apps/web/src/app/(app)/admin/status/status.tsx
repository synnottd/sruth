"use client";

import { useEffect, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

interface QueueFailure {
  id: string;
  type: string;
  sessionId: string | null;
  completedAt: string;
  lastError: string | null;
}

interface QueueSnapshot {
  pending: number;
  claimed: number;
  failed: number;
  oldestPendingAgeMs: number | null;
  recentFailures: QueueFailure[];
}

interface SessionOutput {
  outputId: string;
  name: string;
  platform: string;
  status: string;
  lastError: string | null;
}

interface SessionSnapshot {
  sessionId: string;
  userId: string;
  userEmail: string;
  status: string;
  startedAt: string;
  outputs: SessionOutput[];
}

interface Publisher {
  streamKey: string;
  userEmail: string | null;
  protocol: "rtmp" | "srt";
  uptimeSec: number;
}

interface MediaMtxSnapshot {
  reachable: boolean;
  publishers: Publisher[];
  byProtocol: { rtmp: number; srt: number };
}

interface StatusSnapshot {
  queue: QueueSnapshot;
  sessions: SessionSnapshot[];
  mediamtx: MediaMtxSnapshot;
  generatedAt: string;
}

function QueuePanel({ queue }: { queue: QueueSnapshot }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
      <h2 className="mb-3 text-lg font-semibold">Queue</h2>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <div className="text-xs uppercase text-zinc-400">Pending</div>
          <div data-testid="queue-pending" className="text-2xl font-bold">
            {queue.pending}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase text-zinc-400">Claimed</div>
          <div data-testid="queue-claimed" className="text-2xl font-bold">
            {queue.claimed}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase text-zinc-400">Failed</div>
          <div data-testid="queue-failed" className="text-2xl font-bold text-red-400">
            {queue.failed}
          </div>
        </div>
      </div>
      {queue.recentFailures.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-medium text-zinc-300">Recent failures</h3>
          <ul className="space-y-2">
            {queue.recentFailures.map((f) => (
              <li key={f.id} className="rounded border border-zinc-800 bg-zinc-900 p-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-zinc-400">{f.type}</span>
                  {f.sessionId && <span className="font-mono text-xs text-zinc-500">{f.sessionId}</span>}
                </div>
                {f.lastError && <div className="mt-1 text-red-400">{f.lastError}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SessionsPanel({ sessions }: { sessions: SessionSnapshot[] }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
      <h2 className="mb-3 text-lg font-semibold">Sessions</h2>
      {sessions.length === 0 ? (
        <div className="text-sm text-zinc-500">No active sessions.</div>
      ) : (
        <ul className="space-y-3">
          {sessions.map((s) => (
            <li key={s.sessionId} className="rounded border border-zinc-800 bg-zinc-900 p-3">
              <div className="flex items-center justify-between">
                <div className="font-medium">{s.userEmail}</div>
                <span className="text-xs text-zinc-400">{s.status}</span>
              </div>
              {s.outputs.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {s.outputs.map((o) => (
                    <li key={o.outputId} className="flex items-center justify-between text-sm">
                      <span>{o.name}</span>
                      <span className="text-xs text-zinc-500">{o.status}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MediaMtxBanner() {
  return (
    <div
      data-testid="mediamtx-banner"
      className="rounded-lg border border-red-900 bg-red-950/30 p-4 text-red-300"
    >
      MediaMTX API is unreachable. Publisher data is unavailable.
    </div>
  );
}

function IngestPanel({ mediamtx }: { mediamtx: MediaMtxSnapshot }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
      <h2 className="mb-3 text-lg font-semibold">Ingest</h2>
      <div className="mb-3 flex gap-6 text-sm">
        <div>
          <span className="text-zinc-400">RTMP: </span>
          <span data-testid="ingest-rtmp-count" className="font-mono font-semibold">
            {mediamtx.byProtocol.rtmp}
          </span>
        </div>
        <div>
          <span className="text-zinc-400">SRT: </span>
          <span data-testid="ingest-srt-count" className="font-mono font-semibold">
            {mediamtx.byProtocol.srt}
          </span>
        </div>
      </div>
      {mediamtx.publishers.length === 0 ? (
        <div className="text-sm text-zinc-500">No active publishers.</div>
      ) : (
        <ul className="space-y-2">
          {mediamtx.publishers.map((p) => (
            <li key={p.streamKey} className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-900 p-2 text-sm">
              <div>
                <div className="font-mono">{p.streamKey}</div>
                {p.userEmail && (
                  <div className="text-xs text-zinc-400">owner: {p.userEmail}</div>
                )}
              </div>
              <div className="text-right">
                <div className="text-xs uppercase text-zinc-400">{p.protocol}</div>
                <div className="text-xs text-zinc-500">{p.uptimeSec}s</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function StatusDashboard() {
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null);

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/admin/status/stream`, {
      withCredentials: true,
    });
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as StatusSnapshot;
        setSnapshot(data);
      } catch {
        // Ignore malformed payloads; next tick will overwrite.
      }
    };
    return () => es.close();
  }, []);

  if (!snapshot) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Status</h1>
        <div className="text-sm text-zinc-400">Loading…</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Status</h1>
      {!snapshot.mediamtx.reachable && <MediaMtxBanner />}
      <QueuePanel queue={snapshot.queue} />
      <SessionsPanel sessions={snapshot.sessions} />
      <IngestPanel mediamtx={snapshot.mediamtx} />
    </div>
  );
}
