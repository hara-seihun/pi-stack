export interface RequestTiming {
  id: number;
  method: string;
  path: string;
  startedAt: number;
  durationMs: number;
  state: "pending" | "settled";
}
export interface RequestTimingReport {
  clientId: string;
  platform: "android" | "browser";
  requests: RequestTiming[];
}
export interface ReportedRequestTiming extends RequestTiming {
  clientId: string;
  platform: RequestTimingReport["platform"];
  receivedAt: number;
}

const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "NATIVE"]);
function validTiming(value: unknown): value is RequestTiming {
  if (!value || typeof value !== "object") return false;
  const row = value as RequestTiming;
  return Number.isSafeInteger(row.id) && row.id >= 0 && methods.has(row.method)
    && typeof row.path === "string" && row.path.length <= 512 && !/[?#\s]/.test(row.path)
    && (row.path.startsWith("/v1/") || /^native:[a-zA-Z]+$/.test(row.path))
    && Number.isFinite(row.startedAt) && row.startedAt > 0
    && Number.isFinite(row.durationMs) && row.durationMs >= 1000 && row.durationMs <= 86_400_000
    && (row.state === "pending" || row.state === "settled");
}

/** Per-person supervisor memory, with no message text, headers, query values or durable log. */
export class RequestTimings {
  private rows = new Map<string, ReportedRequestTiming>();
  constructor(private readonly capacity = 200) {}

  receive(value: unknown, now = Date.now()): { ok: true } | { ok: false; error: string } {
    const report = value as RequestTimingReport | null;
    if (!report || typeof report.clientId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(report.clientId)
      || !["android", "browser"].includes(report.platform) || !Array.isArray(report.requests)
      || report.requests.length > 100 || !report.requests.every(validTiming)) return { ok: false, error: "Invalid request timing report" };
    for (const row of report.requests) {
      const key = `${report.clientId}/${row.id}`;
      const previous = this.rows.get(key);
      if (previous?.state === "settled" && row.state === "pending") continue;
      this.rows.delete(key);
      this.rows.set(key, { id: row.id, method: row.method, path: row.path, startedAt: row.startedAt,
        durationMs: row.durationMs, state: row.state, clientId: report.clientId, platform: report.platform, receivedAt: now });
      while (this.rows.size > this.capacity) this.rows.delete(this.rows.keys().next().value!);
    }
    return { ok: true };
  }

  list(now = Date.now()): ReportedRequestTiming[] {
    for (const [key, row] of this.rows) if (now - row.receivedAt > 86_400_000) this.rows.delete(key);
    return [...this.rows.values()].reverse();
  }
}
