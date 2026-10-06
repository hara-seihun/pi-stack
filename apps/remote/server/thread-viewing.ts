import type { Thread, ThreadApi } from "pi-orchestrator/api";

export function createThreadViewRecorder(api: Pick<ThreadApi, "control">, lookup: (id: string) => Thread | null,
  observed: (thread: Thread) => void) {
  const pending = new Map<string, Promise<void>>();
  return function record(id: string, reopened = false): Promise<void> {
    const held = pending.get(id);
    if (held) return held;
    const thread = lookup(id);
    if (!thread || thread.metadata?.archived) return Promise.resolve();
    const viewedAt = thread.metadata?.autoArchiveViewedAt;
    if (!reopened && (thread.state !== "idle" || thread.pendingMessages > 0
      || typeof viewedAt === "number" && viewedAt >= thread.updatedAt)) return Promise.resolve();
    const operation = (async () => {
      const result = await api.control({ threadId: id, action: "view" });
      if (!result.ok) throw new Error(result.error.message);
      observed(result.value);
    })().finally(() => pending.delete(id));
    pending.set(id, operation);
    return operation;
  };
}
