const VARIANT_CLASSES: Record<string, string> = {
  green: "bg-green-500/20 text-green-400",
  yellow: "bg-yellow-500/20 text-yellow-400",
  red: "bg-red-500/20 text-red-400",
  zinc: "bg-zinc-500/20 text-zinc-400",
};

const STATUS_VARIANTS: Record<string, string> = {
  LIVE: "green",
  STARTING: "yellow",
  ERROR: "red",
  STOPPED: "zinc",
  Enabled: "green",
  Disabled: "zinc",
};

export function StatusBadge({ label }: { label: string }) {
  const variant = STATUS_VARIANTS[label] ?? "zinc";

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${VARIANT_CLASSES[variant]}`}
    >
      {label}
    </span>
  );
}
