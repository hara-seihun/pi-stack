import { createHash } from "node:crypto";
import type { SpawnThread } from "./contracts.js";

export function spawnThreadId(requestId: string): string {
  return `spawn-${createHash("sha256").update("pi-thread-spawn-v1\0").update(requestId).digest("hex")}`;
}
export function spawnRequest(input: SpawnThread): SpawnThread {
  return input.id === undefined ? { ...input, id: spawnThreadId(input.requestId) } : input;
}
/** Generated IDs qualify the receipt; they do not change the original caller payload identity. */
export function spawnReceiptInput(input: SpawnThread): Omit<SpawnThread, "createdBy"> {
  const { createdBy: _creator, ...receipt } = input;
  if (receipt.id === spawnThreadId(input.requestId)) {
    const { id: _generated, ...original } = receipt;
    return original;
  }
  return receipt;
}
