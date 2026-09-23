export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Not measured";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

function unit(value: number, name: string): string {
  return `${value} ${name}${value === 1 ? "" : "s"}`;
}

function duration(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (totalMinutes >= 24 * 60) {
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor(totalMinutes % (24 * 60) / 60);
    return `${unit(days, "day")} ${unit(hours, "hour")}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${unit(hours, "hour")} ${unit(minutes, "minute")}`;
}

export function formatResetDistance(resetAt: string | null, now = Date.now()): string {
  if (!resetAt) return "Reset time not reported";
  const reset = Date.parse(resetAt);
  if (!Number.isFinite(reset)) return "Reset time not reported";
  return reset >= now ? `in ${duration(reset - now)}` : `${duration(now - reset)} ago`;
}

export function formatLocalDateTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
