import type { ThreadApi } from "pi-orchestrator/api";

export async function closeAiChat(api: Pick<ThreadApi, "control">, threadId: string) {
  return api.control({ threadId, action: "close" });
}
