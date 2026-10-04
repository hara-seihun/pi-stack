import { contentText } from "@earendil-works/pi-ai";

type WorkEntry = {
  type: string;
  customType?: string;
  data?: unknown;
  message?: { role: string; content?: Parameters<typeof contentText>[0] };
};

export function piWorkReceipts(entries: readonly unknown[]) {
  const accepted = new Set<string>(), completed = new Set<string>(), landed = new Set<string>();
  const pending = new Map<string, { message: string; queued: boolean; landed: boolean }>();
  for (const raw of entries) {
    const entry = raw as WorkEntry;
    if (entry.type === "message" && entry.message?.role === "user") {
      const text = contentText(entry.message.content ?? "", "");
      const match = [...pending].find(([, input]) => !input.landed && input.message === text);
      if (match) { match[1].landed = true; landed.add(match[0]); }
    }
    if (entry.type !== "custom") continue;
    const data = entry.data as { workId?: string; workIds?: string[]; message?: string; delivery?: string; outcome?: string } | undefined;
    if (entry.customType === "thread_input" && data?.workId) {
      accepted.add(data.workId);
      pending.set(data.workId, { message: data.message ?? "", queued: data.delivery === "steer" || data.delivery === "follow_up", landed: false });
    }
    if (entry.customType === "thread_rejected" && data?.workId) {
      accepted.delete(data.workId); completed.delete(data.workId); pending.delete(data.workId);
    }
    if (entry.customType === "thread_settled") for (const id of data?.workIds ?? []) {
      const input = pending.get(id);
      // Older runners included discarded native queue entries in cancelled settlements.
      if (data?.outcome === "cancelled" && input?.queued && !input.landed) {
        accepted.delete(id); completed.delete(id);
      } else completed.add(id);
      pending.delete(id);
    }
    if (entry.customType === "thread_resume" && data?.workId) completed.delete(data.workId);
  }
  return { acceptedWorkIds: [...accepted], completedWorkIds: [...completed], landedWorkIds: [...landed],
    unlandedWorkIds: [...pending].filter(([, input]) => input.queued && !input.landed).map(([id]) => id) };
}
