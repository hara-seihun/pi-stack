import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serveCompletionHost } from "../../src/host/completion-host-runtime.js";

const [root, socketPath, ledgerPath, authPath, agentDir] = process.argv.slice(2);
if (!root || !socketPath || !ledgerPath || !authPath || !agentDir) throw new Error("Missing fixture boundary");
writeFileSync(join(root, "host-pid"), String(process.pid));
await serveCompletionHost({ ledgerPath, authPath, agentDir }, socketPath, async (_input, run, options) => {
  appendFileSync(join(root, "calls"), `${run.id}\n`);
  while (!existsSync(join(root, "release")) && !options.signal.aborted) await delay(10);
  if (options.signal.aborted) return { state: "cancelled", error: { code: "cancelled", message: "fixture cancelled" } };
  return { state: "completed", result: { text: "durable", provider: "openai-codex", model: "gpt-6-luna",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, stopReason: "stop" } };
});
