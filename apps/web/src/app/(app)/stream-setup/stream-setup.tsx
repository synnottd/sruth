"use client";

import { useState } from "react";
import { useStreamInfo, useRotateStreamKey } from "@/lib/api/hooks";
import { ApiError } from "@/lib/api/client";

export function StreamSetup() {
  const { data: streamInfo, isLoading } = useStreamInfo();
  const rotateKey = useRotateStreamKey();
  const [revealed, setRevealed] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isLoading || !streamInfo) {
    return (
      <div data-testid="stream-setup-skeleton" className="space-y-4">
        <div className="h-16 animate-pulse rounded-lg bg-zinc-900" />
        <div className="h-16 animate-pulse rounded-lg bg-zinc-900" />
      </div>
    );
  }

  const maskedKey = streamInfo.streamKey.slice(0, 4) + "********";

  async function handleRotate() {
    setError(null);
    setShowConfirm(false);
    try {
      await rotateKey.mutateAsync();
      setRevealed(false);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Something went wrong");
      }
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Stream Setup</h1>

      <div className="space-y-4">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <p className="text-sm font-medium text-zinc-400">Ingest URL</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="text-sm">{streamInfo.ingestUrl}</code>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(streamInfo.ingestUrl)}
              className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
            >
              Copy
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <p className="text-sm font-medium text-zinc-400">Stream Key</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="text-sm">
              {revealed ? streamInfo.streamKey : maskedKey}
            </code>
            <button
              type="button"
              onClick={() => setRevealed(!revealed)}
              className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
            >
              {revealed ? "Hide" : "Reveal"}
            </button>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(streamInfo.streamKey)}
              className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
            >
              Copy
            </button>
          </div>
        </div>

        <div>
          <button
            type="button"
            onClick={() => setShowConfirm(true)}
            className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700"
          >
            Rotate stream key
          </button>
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
      </div>

      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6">
            <p className="text-sm">
              Are you sure you want to rotate your stream key? Your current key
              will stop working immediately.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={handleRotate}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
