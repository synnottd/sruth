"use client";

import { useState } from "react";
import Link from "next/link";
import { useOutputs, useDeleteOutput } from "@/lib/api/hooks";
import type { Output } from "@/lib/api/types";

function OutputCard({
  output,
  onDelete,
}: {
  output: Output;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">{output.name}</h3>
          <p className="text-sm text-zinc-400">{output.platform}</p>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            output.enabled
              ? "bg-green-500/20 text-green-400"
              : "bg-zinc-500/20 text-zinc-400"
          }`}
        >
          {output.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Link
          href={`/outputs/${output.id}/edit`}
          className="rounded-md bg-zinc-800 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-700"
        >
          Edit
        </Link>
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
  const deleteOutput = useDeleteOutput();
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
            />
          ))}
        </div>
      )}

      {deletingId && (
        <ConfirmDialog
          onConfirm={() => {
            deleteOutput.mutate(deletingId);
            setDeletingId(null);
          }}
          onCancel={() => setDeletingId(null)}
        />
      )}
    </div>
  );
}
