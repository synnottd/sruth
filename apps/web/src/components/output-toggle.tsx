"use client";

import { useEffect, useState } from "react";
import { useToggleOutput } from "@/lib/api/hooks";
import { useToast } from "@/components/toast";
import type { Output } from "@/lib/api/types";

export function OutputToggle({
  output,
  confirmOnDisable,
}: {
  output: Output;
  confirmOnDisable: boolean;
}) {
  const toggle = useToggleOutput();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setConfirming(false);
  }, [output.enabled]);

  async function apply(next: boolean) {
    try {
      await toggle.mutateAsync({ id: output.id, enabled: next });
    } catch {
      toast("Failed to update output", "error");
    }
  }

  function onChange() {
    const next = !output.enabled;
    if (!next && confirmOnDisable) {
      setConfirming(true);
      return;
    }
    apply(next);
  }

  return (
    <>
      <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
        <span className="sr-only">Enabled</span>
        <span
          className={`relative inline-block h-5 w-9 rounded-full transition-colors ${
            output.enabled ? "bg-green-600" : "bg-zinc-700"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
              output.enabled ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </span>
        <input
          type="checkbox"
          className="sr-only"
          checked={output.enabled}
          onChange={onChange}
          disabled={toggle.isPending}
        />
      </label>

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="max-w-sm rounded-lg border border-zinc-800 bg-zinc-950 p-6">
            <p className="text-sm">
              Stop this output? Viewers on this destination will disconnect until
              you turn it back on.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  apply(false);
                }}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
              >
                Stop output
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
