type InputEntry = { type?: string; message?: { role: string; content?: unknown }; customType?: string; data?: unknown };

export function inputReceipts(entries: readonly InputEntry[]) {
  const acceptedWorkIds = new Set<string>(), completedWorkIds = new Set<string>(), landedWorkIds = new Set<string>(), deferredWorkIds = new Set<string>();
  const historicalInputs = new Map<string, string>();
  const text = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(part => part.type === "text").map(part => part.text).join("") : "";
  const defer = (id: string) => { acceptedWorkIds.delete(id); completedWorkIds.delete(id); deferredWorkIds.add(id); historicalInputs.delete(id); };
  for (const entry of entries) {
    if (entry.type === "message" && entry.message?.role === "user") {
      // Older adapters had no landing receipt. Match their inputs in native conversation order.
      const content = text(entry.message.content);
      const input = [...historicalInputs].find(([, message]) => content === message)
        ?? [...historicalInputs].find(([, message]) => message.length > 0 && content.startsWith(`${message}\n\n`));
      if (input) { landedWorkIds.add(input[0]); historicalInputs.delete(input[0]); }
    }
    if (entry.type !== "custom") continue;
    const data = entry.data as { workId?: string; workIds?: string[]; message?: string; receiptVersion?: number; outcome?: string } | undefined;
    if ((entry.customType === "thread_input" || entry.customType === "thread_redelivery") && data?.workId) {
      acceptedWorkIds.add(data.workId); deferredWorkIds.delete(data.workId); completedWorkIds.delete(data.workId);
      if (entry.customType === "thread_input" && !data.receiptVersion) historicalInputs.set(data.workId, data.message ?? "");
    }
    if (entry.customType === "thread_rejected" && data?.workId) {
      acceptedWorkIds.delete(data.workId); historicalInputs.delete(data.workId);
    }
    if (entry.customType === "thread_landed" && data?.workId) landedWorkIds.add(data.workId);
    if (entry.customType === "thread_settled") for (const id of data?.workIds ?? []) {
      if (data?.outcome === "cancelled" && !landedWorkIds.has(id)) defer(id);
      else { completedWorkIds.add(id); historicalInputs.delete(id); }
    }
    if (entry.customType === "thread_deferred") for (const id of data?.workIds ?? []) defer(id);
    if (entry.customType === "thread_resume" && data?.workId) completedWorkIds.delete(data.workId);
  }
  return { acceptedWorkIds: [...acceptedWorkIds], completedWorkIds: [...completedWorkIds], landedWorkIds: [...landedWorkIds], deferredWorkIds: [...deferredWorkIds] };
}
