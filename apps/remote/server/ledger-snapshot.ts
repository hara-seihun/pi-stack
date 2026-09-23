import { statSync } from "node:fs";

export type SnapshotResult = { ok: true } | { ok: false; error: string };

export function snapshotLedger(source: string, target: string) {
  const worker = new Worker(new URL("./ledger-snapshot-worker.ts", import.meta.url).href);
  let finish!: (result: SnapshotResult) => void;
  const result = new Promise<SnapshotResult>((resolve) => { finish = resolve; });
  const timer = setTimeout(() => finish({ ok: false, error: "Ledger snapshot exceeded two minutes" }), 120_000);
  worker.onmessage = (event: MessageEvent<SnapshotResult>) => finish(event.data);
  worker.onerror = (event) => finish({ ok: false, error: event.message || "Ledger snapshot worker failed" });
  worker.postMessage({ source, target });
  return {
    result: result.finally(() => { clearTimeout(timer); worker.terminate(); }),
    stop() { finish({ ok: false, error: "Supervisor is stopping" }); },
  };
}

export function startLedgerSnapshots(source: string, target: string, report: (error: string) => void, intervalMs = 6 * 60 * 60_000) {
  let pending: ReturnType<typeof snapshotLedger> | null = null;
  let stopped = false;
  const refresh = async () => {
    if (stopped || pending) return;
    try { if (Date.now() - statSync(target).mtimeMs < intervalMs) return; }
    catch (error: any) { if (error.code !== "ENOENT") { report(error.message); return; } }
    pending = snapshotLedger(source, target);
    const result = await pending.result;
    pending = null;
    if (!result.ok && !stopped) report(result.error);
  };
  void refresh();
  const timer = setInterval(() => void refresh(), Math.min(intervalMs, 60_000));
  return () => { stopped = true; clearInterval(timer); pending?.stop(); };
}
