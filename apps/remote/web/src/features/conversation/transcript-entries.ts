// Heads are what the stream delivers; `ContextEntry` is what the transcript
// renders. The mapping is mechanical and lossless for everything the collapsed
// view shows: inline text arrives with the head, lazy kinds carry a preview and
// their body loads when the person expands the step.

import { AGENT_NAME } from "../../../../server/agent-identity";
import type { TranscriptItemHead } from "../../../../server/protocol";
import type { ContextEntry } from "../../types";
import { assertNever } from "../../../../shared/explicit-state";
import { validateTranscriptHead } from "../../../../shared/state-validation";
import { presentAgentMessage } from "./agent-message";

export function entryLabel(head: TranscriptItemHead): string {
  validateTranscriptHead(head);
  switch (head.kind) {
    case "user": return head.label || "User";
    // The agent is Kenan on every screen; a head stored before the rename still says so.
    case "assistant": return AGENT_NAME;
    case "notice": return head.label || "Notice";
    case "system": return head.label || "System";
    case "tool": return head.label || "tool";
    case "thinking": return head.label || "Thinking";
    case "toolCall": return head.name || "tool";
  }
  return assertNever(head, "Transcript label");
}

/** `bodyLoaded` joins the signature so a memoized step re-renders when the full body lands. */
export function entryFromHead(head: TranscriptItemHead, bodyLoaded = false): ContextEntry {
  const metrics = head.responseMetrics;
  const metricsSignature = metrics
    ? `:metrics:${metrics.ttftMs}:${metrics.generationMs}:${metrics.outputTokens}:${metrics.tokensPerSecond ?? "null"}`
    : "";
  const inputSignature = head.kind === "user" && head.inputId ? `:input:${head.inputId}:${JSON.stringify(head.inputState ?? null)}` : "";
  const base = {
    key: head.sourceKey ?? `${head.kind}:${head.seq}`,
    signature: `${head.id}${head.kind === "user" ? `:origin:${head.inputOrigin ?? "unset"}` : ""}${head.monoVisibility === undefined ? "" : `:mono:${head.monoVisibility}`}${bodyLoaded ? ":body" : ""}${"textTruncated" in head && head.textTruncated ? ":preview" : ""}${metricsSignature}${inputSignature}${head.kind === "user" || head.kind === "assistant" ? `${head.label ?? ""}:${JSON.stringify(head.agentSender ?? null)}:${head.identity?.id ?? ""}:${JSON.stringify(head.reactions ?? [])}:${JSON.stringify(head.reply ?? null)}` : ""}`,
    kind: head.kind,
    monoVisibility: head.monoVisibility,
    label: entryLabel(head),
    itemId: head.id,
    seq: head.seq,
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
      return presentAgentMessage({ ...base, text: head.text, textTruncated: head.textTruncated, agentSender: head.agentSender, messageTimestamp: head.timestamp, inputOrigin: head.inputOrigin, inputId: head.inputId, inputState: head.inputState, identity: head.identity, reactions: head.reactions, reply: head.reply });
    case "notice":
      return { ...base, text: head.text, textTruncated: head.textTruncated, messageTimestamp: head.timestamp };
    case "system": case "tool": case "thinking":
      return { ...base, preview: head.preview, messageTimestamp: head.timestamp };
  }
  return assertNever(head, "Transcript head");
}

export function entriesFromHeads(heads: readonly TranscriptItemHead[], bodyLoaded?: (id: string) => boolean): ContextEntry[] {
  return heads.map(head => entryFromHead(head, bodyLoaded?.(head.id) ?? false));
}

/** Shown when a thread has no finalized native history yet. */
export const WAITING_ENTRY: ContextEntry = {
  key: "waiting", signature: "waiting", kind: "notice", label: "Context",
  text: "Context will appear when Pi makes its next model request.",
};
