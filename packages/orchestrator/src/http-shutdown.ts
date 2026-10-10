import type { Server } from "node:http";

type ShutdownResult =
  | { ok: true; value: "drained" | "connections-retired" }
  | { ok: false; error: { code: "invalid-budget" | "http-close-failed" | "http-close-timeout"; message: string } };

export function closeHttpServer(server: Server, drainMs: number): Promise<ShutdownResult> {
  if (!Number.isInteger(drainMs) || drainMs < 1 || drainMs > 5_000) {
    return Promise.resolve({ ok: false, error: { code: "invalid-budget", message: "HTTP drain budget must be 1..5000 milliseconds" } });
  }
  return new Promise(resolve => {
    let settled = false;
    let retired = false;
    const finish = (result: ShutdownResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(drain);
      clearTimeout(bound);
      resolve(result);
    };
    const drain = setTimeout(() => {
      retired = true;
      server.closeAllConnections();
    }, drainMs);
    const bound = setTimeout(() => finish({ ok: false, error: { code: "http-close-timeout", message: "HTTP listener did not close after connection retirement" } }), drainMs + 1_000);
    server.close(error => finish(error
      ? { ok: false, error: { code: "http-close-failed", message: error.message } }
      : { ok: true, value: retired ? "connections-retired" : "drained" }));
    server.closeIdleConnections();
  });
}
