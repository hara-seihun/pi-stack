import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeCoreState } from "./journal.js";
import type { CoreExecutionSnapshot, CoreOperation, CoreOperationState, CoreOperationKind, CoreResult } from "./contracts.js";

export const isTerminalOperation = (state: CoreOperationState): boolean =>
  state === "succeeded" || state === "failed" || state === "cancelled";

export class CoreExecutionLedger {
  private revision = 0;
  private stopping = false;
  private readonly operations = new Map<string, CoreOperation>();
  private readonly hashes = new Map<string, string>();
  private readonly path: string;
  constructor(directory: string, private readonly emit: (event: { type: "execution_update"; execution: CoreExecutionSnapshot }) => void) {
    this.path = join(directory, "execution.json");
    if (existsSync(this.path)) {
      const state = JSON.parse(readFileSync(this.path, "utf8"));
      if (state.version !== 1 || !isCoreExecutionSnapshot(state.execution)) throw new Error(`Invalid core execution ledger: ${this.path}`);
      this.revision = state.execution.revision;
      for (const operation of state.execution.operations) this.operations.set(operation.workId, operation);
      for (const [id, hash] of state.hashes) this.hashes.set(id, hash);
    }
  }
  snapshot(): CoreExecutionSnapshot {
    const operations = [...this.operations.values()].map(operation => structuredClone(operation));
    const status = operations.some(operation => operation.state === "unknown") ? "blocked"
      : this.stopping ? "stopping" : operations.some(operation => !isTerminalOperation(operation.state)) ? "running" : "idle";
    return { revision: this.revision, status, operations };
  }
  begin(workId: string, input: unknown, agentId?: string, kind?: CoreOperationKind): { operation: CoreOperation; dispatch: boolean } {
    if (!workId) throw new Error("Core work identity is required");
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const previous = this.operations.get(workId);
    if (previous) {
      if (this.hashes.get(workId) !== hash || previous.agentId !== agentId) throw new Error(`Core work identity reused with different input: ${workId}`);
      return { operation: structuredClone(previous), dispatch: false };
    }
    const operation: CoreOperation = { workId, state: "pending", ...(agentId ? { agentId } : {}), ...(kind ? { kind } : {}) };
    this.operations.set(workId, operation);
    this.hashes.set(workId, hash);
    this.publish();
    return { operation: structuredClone(operation), dispatch: true };
  }
  adopt(operation: CoreOperation, inputHash: string): void {
    if (this.operations.has(operation.workId)) return;
    this.operations.set(operation.workId, structuredClone(operation));
    this.hashes.set(operation.workId, inputHash);
    this.publish();
  }
  transition(workId: string, state: CoreOperationState, error?: string, result?: CoreResult): void {
    const operation = this.operations.get(workId);
    if (!operation) throw new Error(`Unknown core work: ${workId}`);
    if (isTerminalOperation(operation.state)) return;
    // A late acknowledgement cannot erase a terminal event or resolve an ambiguous dispatch.
    if (operation.state === "unknown") return;
    if (operation.state === "running" && (state === "pending" || state === "accepted")) return;
    if (operation.state === "accepted" && state === "pending") return;
    if (operation.state === state && operation.error === error && JSON.stringify(operation.result) === JSON.stringify(result)) return;
    Object.assign(operation, { state, error, result });
    this.publish();
  }
  settleAgent(agentId: string, state: CoreOperationState, error?: string, result?: CoreResult): void {
    for (const operation of [...this.operations.values()]) {
      if (operation.agentId === agentId && operation.kind !== "compact" && operation.kind !== "abort"
        && !isTerminalOperation(operation.state) && operation.state !== "unknown") {
        this.transition(operation.workId, state, error, result);
      }
    }
  }
  setStopping(stopping: boolean): void {
    if (this.stopping === stopping) return;
    this.stopping = stopping;
    this.publish();
  }
  recover(reason = "Native execution was interrupted; its external effects cannot be replayed"): void {
    for (const operation of [...this.operations.values()]) {
      if (!isTerminalOperation(operation.state) && operation.state !== "unknown") this.transition(operation.workId, "unknown", reason);
    }
  }
  private publish(): void {
    this.revision++;
    const execution = this.snapshot();
    writeCoreState(this.path, { version: 1, execution, hashes: [...this.hashes] });
    this.emit({ type: "execution_update", execution });
  }
}

export function isCoreExecutionSnapshot(value: unknown): value is CoreExecutionSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as CoreExecutionSnapshot;
  return Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0
    && ["idle", "running", "stopping", "blocked"].includes(snapshot.status)
    && Array.isArray(snapshot.operations) && snapshot.operations.every(operation => typeof operation?.workId === "string"
      && ["pending", "accepted", "running", "succeeded", "failed", "cancelled", "unknown"].includes(operation.state))
    && new Set(snapshot.operations.map(operation => operation.workId)).size === snapshot.operations.length
    && (snapshot.status !== "idle" || snapshot.operations.every(operation => isTerminalOperation(operation.state)))
    && (snapshot.status !== "blocked" || snapshot.operations.some(operation => operation.state === "unknown"))
    && (!snapshot.operations.some(operation => operation.state === "unknown") || snapshot.status === "blocked");
}
