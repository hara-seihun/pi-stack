import { setTimeout } from "node:timers/promises";

export type RootTransportResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: "http"; status: number }
  | { ok: false; error: "aborted" };

/** The caller supplies one stable ask ID; reconnects never create another request. */
export async function rootRequestResponse(url: string, init: RequestInit, signal: AbortSignal, transport: typeof fetch, retryDelayMs = 150): Promise<RootTransportResult> {
  while (!signal.aborted) {
    try {
      const response = await transport(url, { ...init, signal });
      if (response.status === 503) await response.body?.cancel();
      else if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, error: "http", status: response.status };
      } else {
        const body: unknown = await response.json();
        if (signal.aborted) return { ok: false, error: "aborted" };
        return { ok: true, status: response.status, body };
      }
    } catch {
      if (signal.aborted) return { ok: false, error: "aborted" };
    }
    try { await setTimeout(retryDelayMs, undefined, { signal }); }
    catch { return { ok: false, error: "aborted" }; }
  }
  return { ok: false, error: "aborted" };
}
