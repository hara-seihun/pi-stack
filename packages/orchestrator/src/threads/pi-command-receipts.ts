import { createHash } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PiCommand, PiEvent } from "./contracts.js";
import { assertPiSessionFile, checkpointPiSession } from "./pi-session-file.js";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { assertNever, parseRuntimeEvent } from "./runtime-events.js";

const durable = new Set(["fork", "clone", "new_session", "switch_session", "compact", "bash", "cycle_model", "cycle_thinking_level", "export_html"]);
function digest(command: PiCommand) {
  return createHash("sha256").update(JSON.stringify(command, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex");
}
type Started = { state: "started"; id: string; hash: string; command: string; sourceSessionFile: string };
type Completed = Omit<Started, "state"> & { state: "complete"; response: PiEvent; sessionFile: string };
const identity = { id: Type.String(), hash: Type.String(), command: Type.String(), sourceSessionFile: Type.String() };
const receiptSchema = Type.Union([
  Type.Object({ ...identity, state: Type.Literal("started") }),
  Type.Object({ ...identity, state: Type.Literal("complete"), response: Type.Object({ type: Type.Literal("response") }), sessionFile: Type.String() }),
]);
const unconfirmed = (id: string) => ({ kind: "error" as const, message: `Command ${id} has an unconfirmed outcome. It may still be running or have been interrupted; it will not be executed again. Inspect its native command receipt before requesting different work.` });
type Admission = { kind: "execute" } | { kind: "replay"; response: PiEvent; sessionFile: string } | { kind: "error"; message: string };

export type CommandReceiptError = { code: "command-receipt-unconfirmed"; message: string; sourceSessionFile: string; sessionFile: string };
type ReceiptResult<T> = { ok: true; value: T } | { ok: false; error: CommandReceiptError };

export class PiCommandReceipts {
  private readonly pending = new Map<string, { receipt: Started; sourceCwd: string; sourceSessionId: string }>();

  private sourceEntry(active: { receipt: Started; sourceCwd: string; sourceSessionId: string }, type: string, data: unknown): void {
    if (assertPiSessionFile(active.receipt.sourceSessionFile).id !== active.sourceSessionId) throw new Error("Native command source identity changed");
    const source = SessionManager.open(active.receipt.sourceSessionFile, undefined, active.sourceCwd);
    try {
      if (source.getHeader()?.id !== active.sourceSessionId) throw new Error("Native command source identity changed under custody");
      source.appendCustomEntry(type, data); checkpointPiSession(source);
    } finally { source.dispose(); }
  }

  private persistenceError(active: { receipt: Started }, manager: SessionManager, cause: unknown): ReceiptResult<never> {
    return { ok: false, error: { code: "command-receipt-unconfirmed", message: `Command ${active.receipt.id} receipt persistence failed: ${String(cause)}. The native mutation will not be repeated.`,
      sourceSessionFile: active.receipt.sourceSessionFile, sessionFile: manager.getSessionFile()! } };
  }

  begin(command: PiCommand, manager: SessionManager): Admission {
    if (!durable.has(command.type)) return { kind: "execute" };
    if (!command.id) return { kind: "error", message: "A stable command id is required for this native mutation" };
    const hash = digest(command), id = command.id;
    const prior = [...manager.getEntries()].reverse().find(entry => entry.type === "custom"
      && ["thread_command", "thread_command_result"].includes(entry.customType) && (entry.data as Started)?.id === id);
    if (prior?.type === "custom" && !Check(receiptSchema, prior.data)) return { kind: "error", message: `Command ${id} has an invalid native receipt state; it will not be executed again.` };
    const saved = prior?.type === "custom" ? prior.data as Started | Completed : undefined;
    const active = this.pending.get(id);
    if (saved && saved.hash !== hash || active && active.receipt.hash !== hash) return { kind: "error", message: `Command id ${id} belongs to different input` };
    if (saved) {
      switch (saved.state) {
        case "complete": {
          const response = parseRuntimeEvent(saved.response);
          if (!response.ok) return { kind: "error", message: `Command ${id} has an invalid response: ${response.error}` };
          return { kind: "replay", response: response.value, sessionFile: saved.sessionFile };
        }
        case "started": return unconfirmed(id);
      }
      return assertNever(saved);
    }
    if (active) return unconfirmed(id);
    const receipt: Started = { state: "started", id, hash, command: command.type, sourceSessionFile: manager.getSessionFile()! };
    manager.appendCustomEntry("thread_command", receipt);
    checkpointPiSession(manager);
    this.pending.set(id, { receipt, sourceCwd: manager.getCwd(), sourceSessionId: manager.getHeader()!.id });
    return { kind: "execute" };
  }

  attach(manager: SessionManager): ReceiptResult<void> {
    for (const active of this.pending.values()) {
      if (active.receipt.sourceSessionFile === manager.getSessionFile()) continue;
      try {
        manager.appendCustomEntry("thread_command", active.receipt);
        checkpointPiSession(manager);
        this.sourceEntry(active, "thread_command_target", { id: active.receipt.id, sessionFile: manager.getSessionFile() });
      } catch (cause) { return this.persistenceError(active, manager, cause); }
    }
    return { ok: true, value: undefined };
  }

  finish(response: PiEvent, manager: SessionManager): ReceiptResult<PiEvent> {
    const id = String(response.id), active = this.pending.get(id);
    if (!active || response.type !== "response") return { ok: true, value: response };
    const receipt: Completed = { ...active.receipt, state: "complete", response, sessionFile: manager.getSessionFile()! };
    try {
      manager.appendCustomEntry("thread_command_result", receipt);
      checkpointPiSession(manager);
      if (active.receipt.sourceSessionFile !== manager.getSessionFile()) this.sourceEntry(active, "thread_command_result", receipt);
    } catch (cause) { return this.persistenceError(active, manager, cause); }
    this.pending.delete(id);
    return { ok: true, value: response };
  }
}
