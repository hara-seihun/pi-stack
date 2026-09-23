// Heads are what the stream delivers; `ContextEntry` is what the transcript
// renders. The mapping is mechanical and lossless for everything the collapsed
// view shows: inline text arrives with the head, lazy kinds carry a preview and
// their body loads when the person expands the step.

import { AGENT_NAME } from "../../../../server/agent-identity";
import type { TranscriptItemHead } from "../../../../server/protocol";
import type { ContextEntry } from "../../types";

export function entryLabel(head: TranscriptItemHead): string {
  switch (head.kind) {
    case "user": return head.label || "User";
    // The agent is Kenan on every screen; a head stored before the rename still says so.
    case "assistant": return AGENT_NAME;
    case "notice": return head.label || "Notice";
    case "system": return head.label || "System";
    case "tool": return head.label || "tool";
    case "thinking": return head.label || "Thinking";
    default: return head.name || "tool";
  }
}

/** `bodyLoaded` joins the signature so a memoized step re-renders when the full body lands. */
export function entryFromHead(head: TranscriptItemHead, bodyLoaded = false): ContextEntry {
  const metrics = head.responseMetrics;
  const metricsSignature = metrics
    ? `:metrics:${metrics.ttftMs}:${metrics.generationMs}:${metrics.outputTokens}:${metrics.tokensPerSecond ?? "null"}`
    : "";
  const base = {
    key: `${head.kind}:${head.seq}`,
    signature: `${head.id}${bodyLoaded ? ":body" : ""}${metricsSignature}${head.kind === "user" || head.kind === "assistant" ? `${head.identity?.id ?? ""}:${JSON.stringify(head.reactions ?? [])}` : ""}`,
    kind: head.kind,
    label: entryLabel(head),
    itemId: head.id,
    size: head.size,
    bodyLoaded,
    responseMetrics: metrics,
  };
  if (head.kind === "toolCall") {
    return {
      ...base,
      time: head.timestamp,
      toolCall: { id: head.callId, name: head.name, arguments: head.arguments, partialOutput: head.partialOutput },
      argumentsTruncated: head.argumentsTruncated,
      toolResult: head.result,
    };
  }
  switch (head.kind) {
    case "user":
    case "assistant":
      return { ...base, text: head.text, messageTimestamp: head.timestamp, identity: head.identity, reactions: head.reactions };
    case "notice":
      return { ...base, text: head.text, messageTimestamp: head.timestamp };
    default:
      return { ...base, preview: head.preview, messageTimestamp: head.timestamp };
  }
}

export function entriesFromHeads(heads: readonly TranscriptItemHead[], bodyLoaded?: (id: string) => boolean): ContextEntry[] {
  return heads.map(head => entryFromHead(head, bodyLoaded?.(head.id) ?? false));
}

/** Shown when a thread has no captured context yet. */
export const WAITING_ENTRY: ContextEntry = {
  key: "waiting", signature: "waiting", kind: "notice", label: "Context",
  text: "Context will appear when Pi makes its next model request.",
};
