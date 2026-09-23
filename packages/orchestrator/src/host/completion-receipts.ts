import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompletionService } from "../completion.js";
import { isCompletionExecution, type CompletionExecution } from "../completion-contract.js";
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
