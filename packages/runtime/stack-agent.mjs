#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { requireStandaloneAgent, settleStandaloneAgent, standaloneRecordPath } from "./standalone-agent.mjs";

export function processGroupSettled(pid) {
  try { process.kill(-pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}

export async function runStackAgent(command, args, options = {}) {
  const executionId = options.executionId ?? randomUUID();
  const custody = await requireStandaloneAgent({ recordPath: options.recordPath ?? standaloneRecordPath(),
    agentId: options.agentId ?? `cli:${executionId}`, executionId, env: options.env ?? process.env });
  let child;
  try {
    const ownedLauncher = fileURLToPath(new URL("./stack-pi.mjs", import.meta.url));
    let resolved;
    try { resolved = realpathSync(command); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (resolved === ownedLauncher) {
      command = process.execPath;
      args = [fileURLToPath(new URL("./node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url)), ...args];
    }
    child = spawn(command, args, { stdio: "inherit", env: options.env ?? process.env, cwd: options.cwd, detached: true });
  }
  catch (error) { await settleStandaloneAgent(custody); throw error; }
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
  const forward = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") console.error(`Agent cancellation failed: ${error.message}; custody retained until settlement`); } } };
  const handlers = signals.map(signal => { const handler = () => forward(signal); process.on(signal, handler); return [signal, handler]; });
  try {
    const result = await new Promise(resolve => {
      let spawnError;
      child.once("error", error => { spawnError = error; });
      child.once("close", (code, signal) => resolve({ code, signal, spawnError }));
    });
    if (child.pid && !processGroupSettled(child.pid)) throw new Error(`Agent process group ${child.pid} is still alive; global custody retained`);
    await settleStandaloneAgent(custody);
    if (result.spawnError) throw result.spawnError;
    return result.code ?? (result.signal === "SIGINT" ? 130 : 143);
  } finally { for (const [signal, handler] of handlers) process.off(signal, handler); }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { record: { type: "string" }, agent: { type: "string" }, execution: { type: "string" } } });
    if (!positionals.length) throw new Error("usage: stack-agent [--record PATH --agent ID --execution ID] -- COMMAND [ARGS...]");
    process.exitCode = await runStackAgent(positionals[0], positionals.slice(1), { recordPath: values.record, agentId: values.agent, executionId: values.execution });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
