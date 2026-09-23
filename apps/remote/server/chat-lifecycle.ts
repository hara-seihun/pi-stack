import type { ThreadApi } from "pi-orchestrator/api";

export async function closeAiChat(api: Pick<ThreadApi, "control">, threadId: string) {
  const stopped = await api.control({ threadId, action: "stop", descendants: true });
  if (!stopped.ok) return stopped;
  return api.control({ threadId, action: "update", archived: true });
}
