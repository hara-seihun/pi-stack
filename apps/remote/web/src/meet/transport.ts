import { abortable } from "../abortable";

export type MeetRequest = (path: string, init: RequestInit) => Promise<Response>;

type MeetResponse = { status: number; ok: boolean; text: string };
type MeetTransportResult =
  | { ok: true; value: MeetResponse }
  | { ok: false; error: { kind: "unavailable" | "http" | "protocol"; message: string } };
export type MeetRecoveryResult = MeetTransportResult | { ok: false; error: { kind: "stopped" | "expired"; message: string } };

async function readResponse(request: MeetRequest, path: string, init: RequestInit): Promise<MeetTransportResult> {
  let response: Response;
  let text: string;
  try {
    const operation = request(path, init);
    response = await (init.signal ? abortable(operation, init.signal) : operation);
    const body = response.text();
    text = await (init.signal ? abortable(body, init.signal) : body);
  } catch (cause) {
    return { ok: false, error: { kind: cause instanceof SyntaxError ? "protocol" : "unavailable", message: String(cause instanceof Error ? cause.message : cause) } };
  }
  if (!response.ok && response.status !== 410) {
    let message = text;
    try { message = JSON.parse(text).error || text; } catch {}
    return { ok: false, error: {
      kind: [502, 503, 504].includes(response.status) ? "unavailable" : "http",
      message: message || `Meet HTTP ${response.status}`,
    } };
  }
  return { ok: true, value: { status: response.status, ok: response.ok, text } };
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });
}

// Recovery is only for reads and idempotent writes. The caller owns payload validation.
export async function recoverMeetRequest(request: MeetRequest, path: string, init: RequestInit, stop: AbortSignal): Promise<MeetRecoveryResult> {
  const recovery = new AbortController();
  const timer = setTimeout(() => recovery.abort(), 20_000);
  const lifetime = AbortSignal.any([stop, recovery.signal]);
  let lastError = "Meeting transport unavailable";
  try {
    while (!lifetime.aborted) {
      const attempt = new AbortController();
      const attemptTimer = setTimeout(() => attempt.abort(), 5_000);
      const signal = AbortSignal.any([lifetime, attempt.signal]);
      let result: MeetTransportResult;
      try { result = await readResponse(request, path, { ...init, signal, cache: "no-store" }); }
      finally { clearTimeout(attemptTimer); }
      if (lifetime.aborted) break;
      if (result.ok || result.error.kind !== "unavailable") return result;
      lastError = result.error.message;
      await pause(500, lifetime);
    }
    return { ok: false, error: stop.aborted
      ? { kind: "stopped", message: "Meeting stopped" }
      : { kind: "expired", message: `Meeting transport did not recover within 20 seconds: ${lastError}` } };
  } finally { clearTimeout(timer); }
}

export async function meetJson<T>(request: MeetRequest, path: string, init: RequestInit = {}): Promise<T> {
  const response = await request(path, init);
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try { message = JSON.parse(text).error || text; } catch {}
    throw new Error(message || `Meet HTTP ${response.status}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}
