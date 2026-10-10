import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { Result, Thread } from "../threads/contracts.js";
import type { ThreadService } from "../threads/service.js";
import type { WatchDutyExport, WatchList } from "../threads/watch-list.js";

const START = "<!-- pi-stack-duties-custody:start -->";
const END = "<!-- pi-stack-duties-custody:end -->";
type OwnerState = { held: boolean; archived: boolean; role: Thread["role"] } | null;
export interface DutySnapshot {
  version: 1;
  wakes: ReturnType<ThreadService["exportWakeDuties"]>;
  watches: WatchDutyExport | null;
  owners: Record<string, OwnerState>;
}
export interface MarkdownDutyReceipt {
  path: string; receipt: string; wakeCount: number; watchCount: number; pendingOccurrenceIds: string[];
}
export interface MarkdownDutyAdoption {
  service: ThreadService; watch?: WatchList; path: string;
}
const invalid = (message: string): Result<never> => ({ ok: false, error: { code: "invalid_request", message } });
const digest = (payload: string): string => createHash("sha256").update(payload).digest("hex");

function durableWrite(path: string, body: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, body, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    const dir = openSync(directory, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function snapshot(input: MarkdownDutyAdoption): DutySnapshot {
  const wakes = input.service.exportWakeDuties();
  const exported = input.watch?.exportDuties();
  const watches = exported ? { ...exported, markdownReceipt: null } : null;
  const ids = new Set([
    ...wakes.map(wake => wake.threadId),
    ...(watches?.items.flatMap(item => [item.addedBy, ...(item.lastCheck ? [item.lastCheck.threadId] : []), ...(item.lastThreadId ? [item.lastThreadId] : [])]) ?? []),
    ...(watches?.pendingOccurrences.map(occurrence => occurrence.id) ?? []),
  ]);
  const owners = Object.fromEntries([...ids].sort().map(id => {
    const thread = input.service.get(id);
    return [id, thread ? { held: thread.held, archived: thread.metadata?.archived === true, role: thread.role } : null];
  }));
  return { version: 1, wakes, watches, owners };
}

/** The owning scope supplies the path and unlocked owners. Adoption never dispatches, ticks or releases a stop. */
export function adoptMarkdownDuties(input: MarkdownDutyAdoption): Result<MarkdownDutyReceipt> {
  if (!isAbsolute(input.path)) return invalid("Markdown duty adoption requires an explicit absolute owning path");
  try {
    const existing = existsSync(input.path) ? readFileSync(input.path, "utf8") : "";
    let adopted: DutySnapshot, receipt: string;
    const start = existing.indexOf(START);
    if (start >= 0) {
      if (existing.indexOf(START, start + START.length) >= 0) return invalid("Multiple duty custody blocks in the owning Markdown file");
      const end = existing.indexOf(END, start + START.length);
      if (end < 0) return invalid("Incomplete Markdown duty custody block");
      const block = existing.slice(start + START.length, end);
      const match = block.match(/```json\n(\{[^\n]+\})\n```/);
      if (!match) return invalid("Markdown duty custody snapshot is missing");
      const record = JSON.parse(match[1]!) as { receipt: string; snapshot: DutySnapshot };
      if (!record || !record.snapshot || record.snapshot.version !== 1 || !Array.isArray(record.snapshot.wakes)
        || typeof record.receipt !== "string" || record.receipt !== `markdown-duties:${digest(JSON.stringify(record.snapshot))}`) return invalid("Markdown duty custody receipt does not match its snapshot");
      adopted = record.snapshot; receipt = record.receipt;
    } else {
      adopted = snapshot(input);
      receipt = `markdown-duties:${digest(JSON.stringify(adopted))}`;
      const notes = [
        existing.trimEnd(), "", "## Adopted recurring duties", "",
        "Kenaznia owns timing and dispatch. Judge local day/date, business hours, weekends and holidays before acting. Workers leave their state and next action in their owning Markdown notes and finish.", "",
        "The custody snapshot below is source data, not permission to resume work. Held or archived owners remain stopped. An unknown owner state is unresolved, not actionable. Accepted pending occurrences retain their exact IDs and receipts; do not regenerate or replay them.", "",
        START, "```json", JSON.stringify({ receipt, snapshot: adopted }), "```", END, "",
      ].join("\n");
      durableWrite(input.path, notes);
    }
    const currentWakes = input.service.exportWakeDuties();
    for (const wake of adopted.wakes) {
      const current = currentWakes.find(item => item.threadId === wake.threadId);
      if (current && (current.generation !== wake.generation || JSON.stringify(current.schedule) !== JSON.stringify(wake.schedule))) {
        return { ok: false, error: { code: "conflict", message: `Wake duty changed after its Markdown custody snapshot: ${wake.threadId}` } };
      }
    }
    if (adopted.watches !== null) {
      if (!input.watch) return invalid("This custody snapshot requires its original watch owner");
      const transferred = input.watch.adoptDuties(receipt);
      if (!transferred.ok) return transferred;
    }
    for (const wake of adopted.wakes) {
      const transferred = input.service.adoptWakeDuty(wake.threadId, receipt);
      if (!transferred.ok) return transferred;
    }
    return { ok: true, value: { path: input.path, receipt, wakeCount: adopted.wakes.length,
      watchCount: adopted.watches?.items.length ?? 0,
      pendingOccurrenceIds: [...new Set([...adopted.wakes.flatMap(wake => wake.pendingMessageIds), ...(adopted.watches?.pendingOccurrences.map(occurrence => occurrence.id) ?? [])])] } };
  } catch (error) {
    return { ok: false, error: { code: "unavailable", message: error instanceof Error ? error.message : String(error) } };
  }
}
