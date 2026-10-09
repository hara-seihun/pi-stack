import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PiEvent } from "./contracts.js";
import { checkpointPiSession } from "./pi-session-file.js";

export type InputStatus =
  | { state: "accepted"; commandId: string; workId: string }
  | { state: "rejected"; commandId: string; workId: string; error: string }
  | { state: "in_flight"; commandId: string; workId: string }
  | { state: "never_accepted"; commandId: string; workId: string };

export class PiInputStatus {
  private readonly statuses = new Map<string, InputStatus>();
  constructor(private readonly manager: SessionManager) {
    for (const entry of manager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== "thread_input_status") continue;
      const status = entry.data as InputStatus;
      if (!status || typeof status.commandId !== "string" || typeof status.workId !== "string"
        || !["accepted", "rejected", "in_flight"].includes(status.state)
        || status.state === "rejected" && typeof status.error !== "string") throw new Error("Invalid native input status receipt");
      this.statuses.set(status.commandId, status);
    }
  }
  private save(status: InputStatus): void {
    this.manager.appendCustomEntry("thread_input_status", status);
    checkpointPiSession(this.manager);
    this.statuses.set(status.commandId, status);
  }
  begin(commandId: string, workId: string): InputStatus | undefined {
    const previous = this.statuses.get(commandId);
    if (previous) {
      if (previous.workId !== workId) throw new Error("Native input command identity belongs to different work");
      return previous;
    }
    this.save({ state: "in_flight", commandId, workId });
  }
  finish(event: PiEvent): void {
    if (event.type !== "response" || event.inputUnconfirmed === true) return;
    const status = this.statuses.get(String(event.id));
    if (!status || status.state !== "in_flight") return;
    this.save(event.success === false ? { ...status, state: "rejected", error: String(event.error ?? "Native input rejected") }
      : { ...status, state: "accepted" });
  }
  query(commandId: string, workId: string): InputStatus {
    const status = this.statuses.get(commandId);
    if (status && status.workId !== workId) throw new Error("Native input status identity mismatch");
    if (status) return status;
    // Older adapters recorded admission before their first await. An ordered native query is the ingress barrier.
    const receipt = [...this.manager.getEntries()].reverse().find(entry => entry.type === "custom"
      && ["thread_input", "thread_redelivery", "thread_rejected"].includes(entry.customType) && (entry.data as { workId?: string })?.workId === workId);
    if (receipt?.type === "custom" && receipt.customType === "thread_rejected") return {
      state: "rejected", commandId, workId, error: String((receipt.data as { error?: string }).error ?? "Native input rejected"),
    };
    return { state: receipt ? "accepted" : "never_accepted", commandId, workId };
  }
}
