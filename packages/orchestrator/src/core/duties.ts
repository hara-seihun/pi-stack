import { createHash, randomUUID } from "node:crypto";
import { chownSync, closeSync, existsSync, fchownSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
  service: ThreadService; watch?: WatchList; path: string; uid: number; gid: number;
}
const invalid = (message: string): Result<never> => ({ ok: false, error: { code: "invalid_request", message } });
const digest = (payload: string): string => createHash("sha256").update(payload).digest("hex");

function durableWrite(path: string, body: string, owner: { uid: number; gid: number }): void {
  const directory = dirname(path);
  const missing: string[] = [];
  for (let parent = directory; !existsSync(parent); parent = dirname(parent)) missing.push(parent);
  for (const parent of missing.reverse()) {
    mkdirSync(parent, { mode: 0o700 }); chownSync(parent, owner.uid, owner.gid);
  }
  const existing = existsSync(path) ? lstatSync(path) : null;
  if (existing && !existing.isFile()) throw new Error("Duty Markdown must be an existing regular file or an explicit new output");
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    fchownSync(fd, existing?.uid ?? owner.uid, existing?.gid ?? owner.gid);
    fchmodSync(fd, existing ? existing.mode & 0o777 : 0o600);
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

function parseCustody(existing: string): Result<{ snapshot: DutySnapshot; receipt: string }> {
  try {
    const start = existing.indexOf(START);
    if (start < 0) return invalid("Markdown duty custody block is missing");
    if (existing.indexOf(START, start + START.length) >= 0) return invalid("Multiple duty custody blocks in the owning Markdown file");
    const end = existing.indexOf(END, start + START.length);
    if (end < 0 || existing.indexOf(END, end + END.length) >= 0) return invalid("Incomplete or multiple Markdown duty custody end markers");
    const block = existing.slice(start + START.length, end);
    const match = block.match(/```json\n(\{[^\n]+\})\n```/);
    if (!match) return invalid("Markdown duty custody snapshot is missing");
    const record = JSON.parse(match[1]!) as { receipt: string; snapshot: DutySnapshot };
    if (!record || !record.snapshot || record.snapshot.version !== 1 || !Array.isArray(record.snapshot.wakes)
      || typeof record.receipt !== "string" || record.receipt !== `markdown-duties:${digest(JSON.stringify(record.snapshot))}`) return invalid("Markdown duty custody receipt does not match its snapshot");
    const adopted = record.snapshot;
    if (!adopted.owners || typeof adopted.owners !== "object" || Array.isArray(adopted.owners)
      || adopted.wakes.some(wake => !wake || typeof wake.threadId !== "string" || typeof wake.generation !== "string"
        || !wake.schedule || !Array.isArray(wake.pendingMessageIds) || wake.pendingMessageIds.some(id => typeof id !== "string"))
      || adopted.watches !== null && (!adopted.watches || !Array.isArray(adopted.watches.items) || !Array.isArray(adopted.watches.pendingOccurrences))) return invalid("Malformed Markdown duty custody snapshot");
    return { ok: true, value: { snapshot: adopted, receipt: record.receipt } };
  } catch (error) { return invalid(`Malformed Markdown duty custody snapshot: ${error instanceof Error ? error.message : String(error)}`); }
}

export function validateMarkdownDutyCustody(path: string, expectedReceipt: string): Result<void> {
  try {
    const parsed = parseCustody(readFileSync(path, "utf8"));
    if (!parsed.ok) return parsed;
    if (parsed.value.receipt !== expectedReceipt) return { ok: false, error: { code: "conflict", message: "Markdown duty custody receipt changed after adoption" } };
    return { ok: true, value: undefined };
  } catch (error) { return { ok: false, error: { code: "unavailable", message: error instanceof Error ? error.message : String(error) } }; }
}

/** The owning scope supplies the path and unlocked owners. Adoption never dispatches, ticks or releases a stop. */
export function adoptMarkdownDuties(input: MarkdownDutyAdoption): Result<MarkdownDutyReceipt> {
  if (!isAbsolute(input.path) || !Number.isSafeInteger(input.uid) || input.uid < 0 || !Number.isSafeInteger(input.gid) || input.gid < 0) return invalid("Markdown duty adoption requires an explicit absolute owning path and UID/GID");
  try {
    const existing = existsSync(input.path) ? readFileSync(input.path, "utf8") : "";
    let adopted: DutySnapshot, receipt: string;
    const start = existing.indexOf(START);
    if (start >= 0) {
      const parsed = parseCustody(existing);
      if (!parsed.ok) return parsed;
      adopted = parsed.value.snapshot; receipt = parsed.value.receipt;
    } else {
      if (existing.includes(END) || existing.includes("markdown-duties:")) return invalid("Duty custody start marker is missing from existing receipt-bound evidence");
      adopted = snapshot(input);
      receipt = `markdown-duties:${digest(JSON.stringify(adopted))}`;
      const notes = [
        existing.trimEnd(), "", "## Current recurring duties — editable", "",
        "Edit current duty rows, holds, instructions and next actions in this section or elsewhere outside the custody markers. Current instructions may supersede historical instructions without changing the adoption record.", "",
        "Kenaznia owns timing and dispatch. Judge local day/date, business hours, weekends and holidays before acting. Workers leave their state and next action in their owning Markdown notes and finish.", "",
        "## Immutable adoption custody — do not edit", "",
        "Everything between the custody start/end markers, including the JSON snapshot and receipt, is immutable historical evidence. Do not update its duty text, holds, schedules or owner states; do not recompute its checksum. Put changes to current instructions above this section. A mismatch isolates this duty scope with an explicit custody error and leaves its accepted spool intact; repair from the original receipt-bound evidence.", "",
        "This snapshot is not permission to resume work. Held or archived owners remain stopped. An unknown owner state is unresolved, not actionable. Accepted pending occurrences retain their exact IDs and receipts; do not regenerate or replay them.", "",
        START, "IMMUTABLE RECEIPT-BOUND SNAPSHOT — current instructions belong outside these markers.", "```json", JSON.stringify({ receipt, snapshot: adopted }), "```", END, "",
      ].join("\n");
      durableWrite(input.path, notes, input);
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
