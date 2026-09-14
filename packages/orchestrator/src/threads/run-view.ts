import type { ThreadService } from "./service.js";

export function runViews(owners: Iterable<ThreadService>) {
  const runs = [], live = [];
  for (const owner of owners) for (const thread of owner.snapshot()) {
    const settlement = owner.latestSettlement(thread.id), activity = owner.live(thread.id);
    const active = ["queued", "starting", "running", "stopping"].includes(thread.state) || thread.pendingMessages > 0;
    const state = active ? thread.state === "stopping" ? "running" : thread.state
      : thread.state === "stopped" ? "aborted" : thread.state === "interrupted" ? "failed"
      : settlement?.outcome === "failed" ? "failed" : settlement?.outcome === "cancelled" ? "aborted" : "done";
    const [provider, ...model] = thread.settings.model.split("/");
    const message = settlement?.finalMessage as { content?: unknown } | null;
    const result = typeof message?.content === "string" ? message.content : Array.isArray(message?.content)
      ? message.content.filter(block => block.type === "text").map(block => block.text).join("\n") : undefined;
    runs.push({ id: thread.id, source: thread.metadata?.source ?? "direct", sourceId: thread.metadata?.laneId,
      parentRunId: thread.parentId ?? undefined, cwd: thread.cwd, profile: thread.metadata?.profile ?? model.join("/"),
      provider, model: model.join("/"), thinking: thread.settings.thinkingLevel, state, result,
      sessionFile: thread.sessionFile, createdAt: thread.createdAt, updatedAt: thread.updatedAt,
      startedAt: thread.createdAt, endedAt: !active ? settlement?.time : undefined });
    if (active) live.push({ run_id: thread.id, activity: thread.state !== "running" ? thread.state.toUpperCase()
      : activity?.tools?.length ? "WAITING_ON_TOOL" : activity?.isThinking ? "THINKING" : "WORKING",
      text: activity?.text ?? "", thinking: activity?.thinking ?? "", tool: activity?.tools?.at(-1)?.toolName,
      updated_at: thread.updatedAt });
  }
  return { runs, live };
}
