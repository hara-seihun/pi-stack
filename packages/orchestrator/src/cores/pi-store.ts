import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PiNode } from "./pi-types.js";

export interface PiResultDelivery {
  workId: string;
  agentId: string;
  parentId: string;
  state: PiNode["state"];
  result: string;
  nativeSessionId?: string;
  sessionFile: string;
  delivery: "pending" | "received" | "cancelled";
}

export function writePiState(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.next`;
  const fd = openSync(temp, "w", 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export class PiTreeStore {
  readonly path: string;
  readonly nodes: Map<string, PiNode>;
  readonly requests: Map<string, string>;
  readonly deliveries: Map<string, PiResultDelivery>;
  readonly dispatches: Map<string, { hash: string; state: "pending" | "accepted" | "rejected"; error?: string }>;
  transferHash?: string;
  constructor(directory: string, readonly rootId: string) {
    this.path = join(directory, "pi-tree.json");
    const state = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : undefined;
    if (state && (state.version !== 1 || state.rootId !== rootId)) throw new Error(`Invalid Pi tree: ${this.path}`);
    this.nodes = new Map((state?.nodes ?? []).map((node: PiNode) => [node.id, node]));
    this.requests = new Map(state?.requests ?? []);
    this.deliveries = new Map(state?.deliveries ?? []);
    for (const node of this.nodes.values()) {
      const work = node.work as (PiNode["work"] & { delivered?: boolean });
      if (node.parentId && work?.status === "complete" && !this.deliveries.has(work.id)) this.deliveries.set(work.id, {
        workId: work.id, agentId: node.id, parentId: node.parentId, state: node.state, result: work.result ?? "",
        nativeSessionId: node.nativeSessionId, sessionFile: node.sessionFile, delivery: work.delivered === true ? "received" : "pending",
      });
      if (work) delete work.delivered;
    }
    this.dispatches = new Map(state?.dispatches ?? []);
    this.transferHash = state?.transferHash;
  }
  save(): void {
    writePiState(this.path, JSON.stringify({ version: 1, rootId: this.rootId,
      nodes: [...this.nodes.values()], requests: [...this.requests], deliveries: [...this.deliveries], dispatches: [...this.dispatches], transferHash: this.transferHash }));
  }
}
