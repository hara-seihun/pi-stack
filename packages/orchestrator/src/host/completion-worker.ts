import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompletionClaim, CompletionService } from "../completion.js";
import { isCompletionExecution, type CompletionExecution, type CompletionRecord } from "../completion-contract.js";
import type { OrchestratorConfig, Run } from "../domain.js";
import { executeCompletion } from "./completion-provider.js";

type Request = (path: string) => Promise<any>;
type Post = (path: string, value?: unknown) => Promise<any>;
interface Receipt { runId: string; attemptId: string; outcome: CompletionExecution }
function sync(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function saveCompletionReceipt(directory: string, receipt: Receipt): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${receipt.runId}.json`), temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
    sync(temporary);
    renameSync(temporary, path);
    sync(directory);
  } finally { rmSync(temporary, { force: true }); }
  return path;
}
function readReceipt(path: string, runId: string): Receipt {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value?.runId !== runId || typeof value.attemptId !== "string" || !isCompletionExecution(value.outcome)) throw new Error(`Invalid durable completion receipt ${path}`);
  return value;
}

export function reconcileCompletionReceipts(service: CompletionService, directory: string): number {
  if (!existsSync(directory)) return 0;
  let count = 0;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    let receipt: Receipt;
    try { receipt = readReceipt(path, name.slice(0, -5)); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw cause;
    }
    const outcome = service.settle(receipt.runId, receipt.attemptId, receipt.outcome);
    if (!outcome.ok) throw new Error(`Completion receipt ${name}: ${outcome.error.code}: ${outcome.error.message}`);
    rmSync(path, { force: true });
    sync(directory);
    count++;
  }
  return count;
}

export async function workCompletion(run: Run, config: OrchestratorConfig, post: Post, request: Request, execute = executeCompletion): Promise<boolean> {
  const base = `/internal/runs/${run.id}`;
  const { completion } = await request(`${base}/completion`) as { completion?: CompletionRecord };
  if (!completion) return false;
  const directory = join(config.agentDir, "completion-receipts"), path = join(directory, `${run.id}.json`);
  const settle = async (receipt: Receipt) => {
    await post(`${base}/completion/settle`, { attemptId: receipt.attemptId, outcome: receipt.outcome });
    rmSync(path, { force: true });
    sync(directory);
  };
  if (existsSync(path)) {
    await settle(readReceipt(path, run.id));
    return true;
  }
  if (completion.state !== "queued" && completion.state !== "running") return true;
  const attemptId = crypto.randomUUID();
  const claim = await post(`${base}/completion/claim`, { attemptId }) as CompletionClaim;
  if (!claim.execute) return true;
  if (!claim.input) throw new Error("Completion claim did not include its input");
  const controller = new AbortController();
  const terminate = () => controller.abort();
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  const control = setInterval(() => void request(`${base}/control`).then(value => {
    if (value.abort) controller.abort();
  }).catch(cause => console.error("completion control:", cause)), 2_000);
  const heartbeat = setInterval(() => void post(`${base}/heartbeat`, { progress: false, activity: "WORKING" }).catch(cause => console.error("completion heartbeat:", cause)), 15_000);
  try {
    const outcome = await execute(claim.input, run, { authPath: config.authPath, signal: controller.signal });
    const receipt: Receipt = { runId: run.id, attemptId, outcome };
    saveCompletionReceipt(directory, receipt);
    sync(config.agentDir);
    await settle(receipt);
  } finally {
    clearInterval(control);
    clearInterval(heartbeat);
    process.off("SIGTERM", terminate);
    process.off("SIGINT", terminate);
  }
  return true;
}
