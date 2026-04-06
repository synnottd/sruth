"use client";

import { useState, useRef, useEffect } from "react";
import { useOutputs } from "@/lib/api/hooks";

export function LogsView() {
  const { data: outputs, isLoading } = useOutputs();
  const [selectedOutput, setSelectedOutput] = useState("all");
  const logContainerRef = useRef<HTMLDivElement>(null);
  const [logs] = useState<string[]>([]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  if (isLoading) {
    return (
      <div data-testid="logs-skeleton" className="space-y-4">
        <div className="h-10 w-48 animate-pulse rounded-lg bg-zinc-900" />
        <div className="h-96 animate-pulse rounded-lg bg-zinc-900" />
      </div>
    );
  }

  if (!outputs || outputs.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Logs</h1>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-8 text-center">
          <p className="text-zinc-400">No outputs configured yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Logs</h1>
        <div>
          <label htmlFor="output-select" className="sr-only">
            Output
          </label>
          <select
            id="output-select"
            aria-label="Output"
            value={selectedOutput}
            onChange={(e) => setSelectedOutput(e.target.value)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm focus:border-white focus:outline-none"
          >
            <option value="all">All outputs</option>
            {outputs.map((output) => (
              <option key={output.id} value={output.id}>
                {output.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div
        ref={logContainerRef}
        className="h-[calc(100vh-16rem)] overflow-y-auto rounded-lg border border-zinc-800 bg-black p-4 font-mono text-xs leading-relaxed"
      >
        {logs.length === 0 ? (
          <p className="text-zinc-500">
            Waiting for log data... SSE connection will be established when the
            API endpoint is available.
          </p>
        ) : (
          logs.map((line, i) => (
            <div key={i} className="text-zinc-300">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
