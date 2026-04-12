"use client";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <h2 className="text-xl font-bold">Something went wrong</h2>
      <p className="text-sm text-zinc-400">{error.message}</p>
      <button
        type="button"
        onClick={reset}
        className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black hover:bg-zinc-200"
      >
        Try again
      </button>
    </div>
  );
}
