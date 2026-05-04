"use client";

import { useState } from "react";
import Link from "next/link";
import { useOutputs, useDeleteOutput, useActiveStream } from "@/lib/api/hooks";
import { useToast } from "@/components/toast";
import { OutputToggle } from "@/components/output-toggle";
import type { Output } from "@/lib/api/types";

function OutputCard({
  output,
  onDelete,
  streamIsLive,
}: {
  output: Output;
  onDelete: (id: string) => void;
  streamIsLive: boolean;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">{output.name}</h3>
          <p className="text-sm text-zinc-400">{output.platform}</p>
        </div>
        <OutputToggle output={output} confirmOnDisable={streamIsLive} />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onDelete(output.id)}
          className="rounded-md bg-zinc-800 px-3 py-1 text-sm text-red-400 hover:bg-zinc-700"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function ConfirmDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6">
        <p className="text-sm">Are you sure you want to delete this output?</p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function OutputsList() {
  const { data: outputs, isLoading } = useOutputs();
  const { data: activeStream } = useActiveStream();
  const deleteOutput = useDeleteOutput();
  const { toast } = useToast();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div data-testid="outputs-skeleton" className="space-y-4">
        <div className="h-24 animate-pulse rounded-lg bg-zinc-900" />
        <div className="h-24 animate-pulse rounded-lg bg-zinc-900" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Outputs</h1>
        <Link
          href="/outputs/new"
          className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black hover:bg-zinc-200"
        >
          Add output
        </Link>
      </div>

      {!outputs || outputs.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-8 text-center">
          <p className="text-zinc-400">No outputs configured yet.</p>
          <Link
            href="/outputs/new"
            className="mt-3 inline-block rounded-md bg-white px-4 py-2 text-sm font-medium text-black hover:bg-zinc-200"
          >
            Add your first output
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {outputs.map((output) => (
            <OutputCard
              key={output.id}
              output={output}
              onDelete={setDeletingId}
              streamIsLive={activeStream != null}
            />
          ))}
        </div>
      )}

      {deletingId && (
        <ConfirmDialog
          onConfirm={async () => {
            try {
              await deleteOutput.mutateAsync(deletingId);
              toast("Output deleted");
            } catch {
              toast("Failed to delete output", "error");
            } finally {
              setDeletingId(null);
            }
          }}
          onCancel={() => setDeletingId(null)}
        />
      )}
    </div>
  );
}
