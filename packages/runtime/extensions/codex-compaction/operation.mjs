import { randomUUID } from "node:crypto";

export const ATTEMPT = "codex-compaction-attempt";
export const IDLE_MS = 180_000;
export const DEADLINE_MS = 600_000;

export function blockedAttempt(branch, modelKey) {
  for (const entry of [...branch].reverse()) {
    if (entry.type === "compaction") return;
    if (entry.type === "custom" && entry.customType === ATTEMPT && entry.data?.modelKey === modelKey) {
      return entry.data;
    }
  }
}

export function operationScope(parent, { idleMs = IDLE_MS, deadlineMs = DEADLINE_MS } = {}) {
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const started = Date.now();
  const trace = { attemptId: randomUUID(), phase: "credentials", startedAt: new Date(started).toISOString(), events: 0, bytes: 0 };
  let idle;
  const abort = code => controller.abort(Object.assign(new Error(`Codex compaction ${code} in ${trace.phase}`), { code }));
  const progress = () => {
    clearTimeout(idle);
    idle = setTimeout(() => abort("idle-timeout"), idleMs);
  };
  const deadline = setTimeout(() => abort("deadline"), deadlineMs);
  progress();
  return {
    signal, trace,
    progress(phase) { trace.phase = phase; progress(); },
    snapshot() { return { ...trace, elapsedMs: Date.now() - started, abortCause: signal.aborted ? signal.reason?.code ?? signal.reason?.name ?? "cancelled" : undefined }; },
    close() { clearTimeout(idle); clearTimeout(deadline); },
  };
}

export function abortFailure(signal, error) {
  return signal.aborted ? signal.reason?.message ?? "Codex compaction cancelled" : error;
}

// A fetch implementation can stop forwarding cancellation after response headers.
// Own the reader as well, so a silent stream cannot retain the operation lease.
export function cancellableResponse(response, signal) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let finished = false;
  const cleanup = () => { finished = true; signal.removeEventListener("abort", abort); };
  let target;
  const abort = () => {
    if (finished) return;
    cleanup();
    target.error(signal.reason);
    void reader.cancel(signal.reason).catch(() => {});
  };
  const body = new ReadableStream({
    start(controller) {
      target = controller;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (finished) return;
        if (next.done) { cleanup(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) {
        if (!finished) { cleanup(); controller.error(error); }
      }
    },
    async cancel(reason) { cleanup(); await reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
