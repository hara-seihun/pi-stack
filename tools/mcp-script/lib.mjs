import { Worker } from "node:worker_threads";
import { McpRuntime } from "../mcp/lib.mjs";

function errorRecord(error) {
  return { code: error?.code ?? "mcp_error", message: error?.message ?? String(error) };
}

export async function runScript(code, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");
  const runtime = options.runtime ?? new McpRuntime(options);
  const ownsRuntime = options.runtime === undefined;
  const emitted = [];
  const worker = new Worker(new URL("./worker.mjs", import.meta.url), { workerData: { code } });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error(`mcp-script timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      worker.on("error", reject);
      worker.on("exit", (status) => {
        if (status !== 0) reject(new Error(`mcp-script worker exited with status ${status}`));
      });
      worker.on("message", async (message) => {
        if (message.type === "emit") {
          emitted.push(message.value);
          options.onEmit?.(message.value);
          return;
        }
        if (message.type === "done") {
          resolve({ emitted, ...(message.result === undefined ? {} : { result: message.result }) });
          return;
        }
        if (message.type === "failed") {
          reject(new Error(message.error?.message ?? "mcp-script failed"));
          return;
        }
        if (message.type !== "request") return;
        let value;
        let ok = true;
        try {
          const args = message.args ?? {};
          if (message.method === "search") {
            value = await runtime.search(args);
          } else if (message.method === "describe") {
            try {
              value = await runtime.describe(args.path);
            } catch (error) {
              value = { path: args.path, error: errorRecord(error) };
            }
          } else if (message.method === "call") {
            try {
              value = { ok: true, data: await runtime.call(args.path, args.args ?? {}) };
            } catch (error) {
              value = { ok: false, error: errorRecord(error) };
            }
          } else if (message.method === "status") {
            value = await runtime.status(args);
          } else if (message.method === "list") {
            value = await runtime.list(args.server);
          } else if (message.method === "instructions") {
            value = await runtime.instructions(args.server);
          } else if (message.method === "connect") {
            const connection = await runtime.connect(args.server);
            value = { server: args.server, connected: true, tools: connection.tools.length };
          } else {
            throw new Error(`unknown worker request ${message.method}`);
          }
        } catch (error) {
          ok = false;
          value = errorRecord(error);
        }
        worker.postMessage({ type: "response", id: message.id, ok, ...(ok ? { value } : { error: value }) });
      });
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
    if (ownsRuntime) await runtime.close();
  }
}
