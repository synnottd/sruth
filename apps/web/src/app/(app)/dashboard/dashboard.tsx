"use client";

import Link from "next/link";
import { useOutputs, useActiveStream } from "@/lib/api/hooks";
import { StatusBadge } from "@/components/status-badge";
import { OutputToggle } from "@/components/output-toggle";
import type { Output, StreamSession } from "@/lib/api/types";

function HeroBanner({ activeStream }: { activeStream: StreamSession | null }) {
  if (!activeStream) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6">
        <div className="flex items-center gap-3">
          <div className="h-3 w-3 rounded-full bg-zinc-600" />
          <span className="text-xl font-bold">OFFLINE</span>
        </div>
        <div className="mt-4 flex gap-3">
          <Link
            href="/outputs"
            className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700"
          >
            Configure outputs
          </Link>
          <Link
            href="/stream-setup"
            className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700"
          >
            Copy stream key
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-green-900 bg-green-950/30 p-6">
      <div className="flex items-center gap-3">
        <div className="h-3 w-3 animate-pulse rounded-full bg-green-500" />
        <span className="text-xl font-bold text-green-400">LIVE</span>
      </div>
    </div>
  );
}

function OutputCard({
  output,
  outputSession,
  streamIsLive,
}: {
  output: Output;
  outputSession?: { status: string; lastError: string | null; reconnectCount: number };
  streamIsLive: boolean;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">{output.name}</h3>
          <p className="text-sm text-zinc-400">{output.platform}</p>
        </div>
        <div className="flex items-center gap-2">
          {outputSession && (
            <StatusBadge
              status={outputSession.status}
              reconnectCount={outputSession.reconnectCount}
            />
          )}
          <OutputToggle output={output} confirmOnDisable={streamIsLive} />
        </div>
      </div>
      {outputSession?.lastError && (
        <p className="mt-2 text-sm text-red-400">{outputSession.lastError}</p>
      )}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div data-testid="dashboard-skeleton" className="space-y-6">
      <div className="h-28 animate-pulse rounded-lg bg-zinc-900" />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="h-24 animate-pulse rounded-lg bg-zinc-900" />
        <div className="h-24 animate-pulse rounded-lg bg-zinc-900" />
      </div>
    </div>
  );
}

export function Dashboard() {
  const { data: outputs, isLoading: outputsLoading } = useOutputs();
  const { data: activeStream, isLoading: streamsLoading } = useActiveStream();

  if (outputsLoading || streamsLoading) {
    return <DashboardSkeleton />;
  }

  // Build a lookup from outputId to outputSession for the active stream
  const outputSessionMap = new Map<string, { status: string; lastError: string | null; reconnectCount: number }>();
  if (activeStream) {
    for (const os of activeStream.outputSessions) {
      outputSessionMap.set(os.outputId, {
        status: os.status,
        lastError: os.lastError,
        reconnectCount: os.reconnectCount,
      });
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <HeroBanner activeStream={activeStream ?? null} />
      {outputs && outputs.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {outputs.map((output) => (
            <OutputCard
              key={output.id}
              output={output}
              outputSession={outputSessionMap.get(output.id)}
              streamIsLive={activeStream != null}
            />
          ))}
        </div>
      )}
    </div>
  );
}
