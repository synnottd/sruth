const VARIANT_CLASSES: Record<string, string> = {
  green: "bg-green-500/20 text-green-400",
  yellow: "bg-yellow-500/20 text-yellow-400",
  red: "bg-red-500/20 text-red-400",
  zinc: "bg-zinc-500/20 text-zinc-400",
};

const STATUS_VARIANTS: Record<string, string> = {
  LIVE: "green",
  STARTING: "yellow",
  RETRYING: "yellow",
  ERROR: "red",
  STOPPED: "zinc",
  Enabled: "green",
  Disabled: "zinc",
};

const STATUS_LABELS: Record<string, string> = {
  LIVE: "Live",
  STARTING: "Starting",
  RETRYING: "Retrying",
  ERROR: "Error",
  STOPPED: "Stopped",
};

export function StatusBadge({
  label,
  status,
  reconnectCount,
}: {
  label?: string;
  status?: string;
  reconnectCount?: number;
}) {
  const key = status ?? label ?? "";
  const variant = VARIANT_CLASSES[STATUS_VARIANTS[key] ?? "zinc"];
  let display = label ?? STATUS_LABELS[key] ?? key;
  if (status === "RETRYING" && reconnectCount && reconnectCount > 0) {
    display = `Retrying (attempt ${reconnectCount})`;
  }

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${variant}`}>
      {display}
    </span>
  );
}
