import { createHash } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PiCommand, PiEvent } from "./contracts.js";
import { checkpointPiSession } from "./pi-session-file.js";

const durable = new Set(["fork", "clone", "new_session", "switch_session", "compact", "bash", "cycle_model", "cycle_thinking_level", "export_html"]);
function digest(command: PiCommand) {
  return createHash("sha256").update(JSON.stringify(command, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex");
}
type Started = { state: "started"; id: string; hash: string; command: string; sourceSessionFile: string };
type Completed = Omit<Started, "state"> & { state: "complete"; response: PiEvent; sessionFile: string };
type Admission = { kind: "execute" } | { kind: "replay"; response: PiEvent; sessionFile: string } | { kind: "error"; message: string };

export class PiCommandReceipts {
  private readonly pending = new Map<string, { receipt: Started; source: SessionManager }>();

  begin(command: PiCommand, manager: SessionManager): Admission {
    if (!durable.has(command.type)) return { kind: "execute" };
    if (!command.id) return { kind: "error", message: "A stable command id is required for this native mutation" };
    const hash = digest(command), id = command.id;
    const prior = [...manager.getEntries()].reverse().find(entry => entry.type === "custom"
      && ["thread_command", "thread_command_result"].includes(entry.customType) && (entry.data as Started)?.id === id);
    const saved = prior?.type === "custom" ? prior.data as Started | Completed : undefined;
    const active = this.pending.get(id);
    if (saved && saved.hash !== hash || active && active.receipt.hash !== hash) return { kind: "error", message: `Command id ${id} belongs to different input` };
    if (saved?.state === "complete") return { kind: "replay", response: saved.response, sessionFile: saved.sessionFile };
    if (saved || active) return { kind: "error", message: `Command ${id} has an unconfirmed outcome. It may still be running or have been interrupted; it will not be executed again. Inspect its native command receipt before requesting different work.` };
    const receipt: Started = { state: "started", id, hash, command: command.type, sourceSessionFile: manager.getSessionFile()! };
    manager.appendCustomEntry("thread_command", receipt);
    checkpointPiSession(manager);
    this.pending.set(id, { receipt, source: manager });
    return { kind: "execute" };
  }

  attach(manager: SessionManager): void {
    for (const { receipt, source } of this.pending.values()) {
      if (source.getSessionFile() === manager.getSessionFile()) continue;
      manager.appendCustomEntry("thread_command", receipt);
      checkpointPiSession(manager);
      source.appendCustomEntry("thread_command_target", { id: receipt.id, sessionFile: manager.getSessionFile() });
      checkpointPiSession(source);
    }
  }

  finish(response: PiEvent, manager: SessionManager): void {
    const id = String(response.id), active = this.pending.get(id);
    if (!active || response.type !== "response") return;
    const receipt: Completed = { ...active.receipt, state: "complete", response, sessionFile: manager.getSessionFile()! };
    manager.appendCustomEntry("thread_command_result", receipt);
    checkpointPiSession(manager);
    if (active.source.getSessionFile() !== manager.getSessionFile()) {
      active.source.appendCustomEntry("thread_command_result", receipt);
      checkpointPiSession(active.source);
    }
    this.pending.delete(id);
  }
}
