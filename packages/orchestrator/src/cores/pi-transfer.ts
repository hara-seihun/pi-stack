import { closeSync, existsSync, fsyncSync, openSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PortableConversation } from "./contracts.js";
import { writePiState } from "./pi-store.js";

export function preparePiSession(manager: SessionManager): void {
  const path = manager.getSessionFile();
  if (!path) throw new Error("Pi core sessions must be durable");
  // Pi defers creating new-session files until its first assistant response.
  // Reopen the initial header so Pi owns incremental persistence from here.
  if (!existsSync(path)) {
    writePiState(path, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    manager.setSessionFile(path);
  }
}

export function checkpointPiSession(manager: SessionManager): void {
  const path = manager.getSessionFile();
  if (!path) throw new Error("Pi core sessions must be durable");
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function seedPiSession(path: string, cwd: string, transfer?: PortableConversation): void {
  if (transfer && transfer.version !== 1) throw new Error("Unsupported portable conversation version");
  const manager = SessionManager.inMemory(cwd);
  if (transfer) manager.appendCustomEntry("core_transfer", { sourceCore: transfer.sourceCore, agents: transfer.agents });
  for (const message of transfer?.messages ?? []) {
    if (transfer?.sourceCore === "pi" && ["user", "assistant", "toolResult", "custom", "bashExecution"].includes(String(message.role))) {
      manager.appendMessage(message as unknown as Parameters<SessionManager["appendMessage"]>[0]);
    } else if (message.role === "user" && (typeof message.content === "string" || Array.isArray(message.content))) {
      manager.appendMessage({ ...message, timestamp: message.timestamp ?? Date.now() } as Parameters<SessionManager["appendMessage"]>[0]);
    } else {
      // Foreign provider reasoning signatures and tool-call IDs must not become
      // executable Pi history. Preserve the complete record as visible context.
      manager.appendCustomMessageEntry("core_transfer_message", JSON.stringify(message), true, { sourceCore: transfer!.sourceCore, message });
    }
  }
  writePiState(path, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
}
