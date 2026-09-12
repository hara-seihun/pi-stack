import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PiNode } from "./pi-types.js";

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
  readonly dispatches: Map<string, { hash: string; state: "pending" | "accepted" | "rejected"; error?: string }>;
  transferHash?: string;
  constructor(directory: string, readonly rootId: string) {
    this.path = join(directory, "pi-tree.json");
    const state = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : undefined;
    if (state && (state.version !== 1 || state.rootId !== rootId)) throw new Error(`Invalid Pi tree: ${this.path}`);
    this.nodes = new Map((state?.nodes ?? []).map((node: PiNode) => [node.id, node]));
    this.requests = new Map(state?.requests ?? []);
    this.dispatches = new Map(state?.dispatches ?? []);
    this.transferHash = state?.transferHash;
  }
  save(): void {
    writePiState(this.path, JSON.stringify({ version: 1, rootId: this.rootId,
      nodes: [...this.nodes.values()], requests: [...this.requests], dispatches: [...this.dispatches], transferHash: this.transferHash }));
  }
}
