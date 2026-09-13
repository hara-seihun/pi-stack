import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export interface EncodedAnthropicRequest { body: string; headers: Record<string, string> }
export interface OAuthEncoder {
  encode(payload: Record<string, unknown>, sessionId: string, signal: AbortSignal): Promise<EncodedAnthropicRequest>;
  close(): Promise<void>;
}

// The subscription extension owns the request fingerprint. Its global fetch hook
// lives in this worker, never in the orchestrator or Codex process.
const workerSource = String.raw`
(async () => {
  const { parentPort, workerData } = await import("node:worker_threads");
  let hook;
  globalThis.fetch = async (_input, init) => ({
    body: Buffer.from(init.body).toString("utf8"),
    headers: Object.fromEntries(new Headers(init.headers)),
  });
  const extension = await import(workerData.moduleUrl);
  extension.default({ on: (name, callback) => {
    if (name !== "before_provider_request") throw new Error("Unexpected claude-oauth hook: " + name);
    hook = callback;
  } });
  if (!hook) throw new Error("claude-oauth did not register its request hook");
  parentPort.on("message", async ({ id, payload, sessionId }) => {
    try {
      const instructions = payload.system;
      payload.system = [
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        ...instructions.map(block => ({ ...block, text: "Codex instruction block" })),
      ];
      hook({ payload });
      if (!payload.system[0]?.text?.startsWith("x-anthropic-billing-header:") || payload.system.length !== instructions.length + 2) {
        throw new Error("claude-oauth did not produce its subscription request header and instruction blocks");
      }
      // Keep the package's cache policy, but restore untouched instruction text
      // before its fetch hook fingerprints the final serialized body.
      instructions.forEach((block, index) => { payload.system[index + 2].text = block.text; });
      const identity = JSON.parse(payload.metadata.user_id);
      payload.metadata.user_id = JSON.stringify({ ...identity, session_id: sessionId });
      const result = await fetch("https://api.anthropic.com/v1/messages?beta=true", {
        method: "POST", body: JSON.stringify(payload),
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      });
      parentPort.postMessage({ id, result });
    } catch (error) {
      parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
  parentPort.postMessage({ ready: true });
})();`;

export async function createOAuthEncoder(moduleUrl = pathToFileURL(createRequire(import.meta.url).resolve("@pi-plugins/claude-oauth")).href): Promise<OAuthEncoder> {
  const worker = new Worker(workerSource, { eval: true, workerData: { moduleUrl } });
  let failure: Error | undefined;
  let serial = 0;
  const pending = new Map<number, { resolve(value: EncodedAnthropicRequest): void; reject(error: Error): void }>();
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const fail = (error: Error) => {
    failure = error;
    readyReject(error);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  worker.on("error", fail);
  worker.on("exit", code => fail(new Error(`Anthropic OAuth encoder closed (${code})`)));
  worker.on("message", message => {
    if (message.ready) { readyResolve(); return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.result);
  });
  try { await ready; } catch (error) { await worker.terminate(); throw error; }
  let closing: Promise<void> | undefined;
  return {
    async encode(payload, sessionId, signal) {
      signal.throwIfAborted();
      if (failure) throw failure;
      const id = ++serial;
      let abort!: () => void;
      try {
        return await new Promise<EncodedAnthropicRequest>((resolve, reject) => {
          abort = () => { pending.delete(id); reject(signal.reason); };
          signal.addEventListener("abort", abort, { once: true });
          pending.set(id, { resolve, reject });
          worker.postMessage({ id, payload, sessionId });
        });
      } finally { signal.removeEventListener("abort", abort); }
    },
    close() {
      return closing ??= (async () => {
        fail(new Error("Anthropic OAuth encoder closed"));
        await worker.terminate();
      })();
    },
  };
}
