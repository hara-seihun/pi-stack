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

/** Token counts at a glance: 950, 12k, 3.4M, 21B. */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "—";
  const scaled = (value: number, suffix: string) => `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}${suffix}`;
  if (tokens >= 1e9) return scaled(tokens / 1e9, "B");
  if (tokens >= 1e6) return scaled(tokens / 1e6, "M");
  if (tokens >= 1e3) return scaled(tokens / 1e3, "k");
  return String(Math.round(tokens));
}

/** Whole dollars, with cents only below ten. */
export function formatDollars(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  return value < 10 ? `$${value.toFixed(2)}` : `$${Math.round(value).toLocaleString("en-US")}`;
}

/** A share of a whole: one decimal below ten percent, "<0.1%" for trace use. */
export function formatShare(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return "0%";
  if (percent < 0.1) return "<0.1%";
  return percent < 10 ? `${percent.toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(percent)}%`;
}

/** "Mon 12:00 AM" for a reset within the coming week. */
export function formatWeekReset(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(date);
}
