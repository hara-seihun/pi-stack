import { chmodSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { Store } from "../store.js";
import { CompletionService } from "../completion.js";
import { CompletionExecutionPool } from "./completion-execution.js";
import { executeCompletion } from "./completion-provider.js";
import { reconcileCompletionReceipts } from "./completion-receipts.js";
import type { CompletionHostBoundary, CompletionHostCommand, CompletionHostStatus } from "./completion-transport.js";
import { assertNever } from "../threads/runtime-events.js";

function isHostCommand(value: unknown): value is CompletionHostCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as { type?: unknown; runId?: unknown };
  return command.type === "status" || command.type === "close" || (command.type === "start" && typeof command.runId === "string");
}

/** Caller must hold socketPath.lock for the complete lifetime (the unit uses flock). */
export async function serveCompletionHost(boundary: CompletionHostBoundary, socketPath: string,
  execute = executeCompletion): Promise<void> {
  const store = Store.open(boundary.ledgerPath);
  const service = new CompletionService(store, process.cwd());
  const pool = new CompletionExecutionPool(store, service, boundary, execute);
  const sockets = new Set<Socket>();
  let closing = false, idleSince = Date.now();
  const status = (): CompletionHostStatus => ({ ok: true, boundary, runIds: pool.runIds });
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const server = createServer(socket => {
    sockets.add(socket);
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", chunk => {
      input += chunk.toString();
      if (input.length > 4096) { socket.end(`${JSON.stringify({ ok: false, error: "Completion host command exceeds boundary" })}\n`); return; }
      const end = input.indexOf("\n"); if (end < 0) return;
      socket.removeAllListeners("data");
      try {
        const command: unknown = JSON.parse(input.slice(0, end));
        if (!isHostCommand(command)) throw new Error("Invalid completion host command");
        if (closing) throw new Error("Completion host is retiring; admission remains in the ledger");
        switch (command.type) {
          case "status": socket.end(`${JSON.stringify(status())}\n`); return;
          case "start": {
            if (typeof command.runId !== "string") throw new Error("Completion host requires a run ID");
            const run = store.run(command.runId);
            if (!run || run.workerUnit !== `completion:${run.id}` || !service.byRun(run.id)) throw new Error("Run is not an admitted completion in this ledger");
            idleSince = Date.now();
            pool.start(run);
            socket.end(`${JSON.stringify(status())}\n`); return;
          }
          case "close": socket.end(`${JSON.stringify(status())}\n`); void close(); return;
        }
        assertNever(command);
      } catch (cause) { socket.end(`${JSON.stringify({ ok: false, error: String(cause) })}\n`); }
    });
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  async function close() {
    if (closing) return; closing = true;
    clearInterval(timer);
    server.close();
    for (const socket of sockets) socket.destroy();
    try { await pool.close(); }
    finally { store.close(); rmSync(socketPath, { force: true }); finish(); }
  }
  const stop = () => { void close(); };
  try {
    reconcileCompletionReceipts(service, join(boundary.agentDir, "completion-receipts"));
    rmSync(socketPath, { force: true });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    chmodSync(socketPath, 0o600);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
    timer = setInterval(() => {
      try {
        pool.tick();
        if (pool.size) idleSince = Date.now();
        if (process.exitCode || Date.now() - idleSince >= 5_000) void close();
      } catch (cause) { console.error("completion host:", cause); process.exitCode = 1; void close(); }
    }, 250);
    await done;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.removeListener(signal, stop);
    await close();
  }
}

