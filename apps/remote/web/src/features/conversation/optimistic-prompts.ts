import type { PromptOutboxEntry } from "../../prompt-outbox";
import type { ContextEntry } from "../../types";

export type PromptDelivery =
  | { state: "sending" | "delivered" | "read" }
  | { state: "failed"; message: string; retryRequestId?: string };

export function promptDelivery(entry: PromptOutboxEntry, sending: boolean): PromptDelivery {
  switch (entry.outcome.kind) {
    case "accepted": return { state: "delivered" };
    case "rejected": return { state: "failed", message: entry.outcome.message };
    case "pending": return sending ? { state: "sending" }
      : { state: "failed", message: entry.outcome.message, retryRequestId: entry.requestId };
  }
}

export function reconcilePromptEntries(entries: readonly ContextEntry[], prompts: readonly PromptOutboxEntry[], sending: ReadonlySet<string>): ContextEntry[] {
  const pending = new Map(prompts.map(prompt => [prompt.requestId, prompt]));
  const result = entries.filter(entry => entry.key !== "waiting" || prompts.length === 0).map(entry => {
    if (entry.kind !== "user" || !entry.inputId || entry.agentSender || entry.inputOrigin === "machine") return entry;
    const prompt = prompts.find(prompt => prompt.requestId === entry.inputId || prompt.outcome.kind === "accepted" && prompt.outcome.workId === entry.inputId);
    if (prompt) pending.delete(prompt.requestId);
    const delivery: PromptDelivery = entry.inputState && (entry.inputState.landedAt != null || entry.inputState.state === "done" && entry.inputState.outcome === "complete")
      ? { state: "read" } : { state: "delivered" };
    const key = `input:${entry.inputId}`;
    return { ...entry, key, promptDelivery: delivery, signature: `${entry.signature}:delivery:${delivery.state}` };
  });
  for (const prompt of pending.values()) {
    const body = JSON.parse(prompt.bodyJson) as { text: string };
    const delivery = promptDelivery(prompt, sending.has(prompt.requestId));
    result.push({ key: `input:${prompt.requestId}`, signature: `${prompt.bodyJson}:${JSON.stringify(delivery)}`, kind: "user",
      label: "You", inputOrigin: "human", promptRequestId: prompt.requestId, text: body.text, messageTimestamp: prompt.createdAt, promptDelivery: delivery });
  }
  return result;
}

export function capturedPromptIds(entries: readonly ContextEntry[], prompts: readonly PromptOutboxEntry[]): string[] {
  const ids = new Set(entries.filter(entry => entry.kind === "user").map(entry => entry.inputId));
  return prompts.filter(prompt => prompt.outcome.kind === "accepted" && ids.has(prompt.outcome.workId)).map(prompt => prompt.requestId);
}
