import type { ReactNode } from "react";
import type { ContextEntry } from "../../types";

const PREFIX = "<agent_message>\nThis is an agent-to-agent message, not a user message.\n";
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Recognize the persisted thread transport envelope, not mentions or quoted examples.
 * This is presentation only: it never changes a message's text, identity or history.
 * Both older heads and newly streamed heads carry the same envelope.
 */
export function agentMessageSender(entry: Pick<ContextEntry, "kind" | "text">): string | null {
  if (entry.kind !== "user" || !entry.text?.startsWith(PREFIX)) return null;
  const text = entry.text;
  const end = text.indexOf("\n\n", PREFIX.length);
  if (end < 0 || !text.includes("\n</agent_message>", end)) return null;
  try {
    const metadata = JSON.parse(text.slice(PREFIX.length, end));
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
      || typeof metadata.senderThreadId !== "string" || !THREAD_ID.test(metadata.senderThreadId)) return null;
    // Child completion notices have only senderThreadId. Explicit sends also
    // carry recipientThreadId/messageId/source. Reject incomplete examples.
    if (Object.keys(metadata).length !== 1 && (metadata.source !== "explicit"
      || typeof metadata.recipientThreadId !== "string" || !THREAD_ID.test(metadata.recipientThreadId)
      || typeof metadata.messageId !== "string" || !metadata.messageId)) return null;
    return metadata.senderThreadId;
  } catch { return null; }
}

/** Native details/summary matches Thinking's pointer, touch and keyboard semantics. */
export function AgentMessage({ senderThreadId, children }: { senderThreadId: string; children: ReactNode }) {
  return <details className="conversation-step text-step agent-message-step">
    <summary>
      <span className="work-chevron" aria-hidden="true">›</span>
      <span className="step-summary"><strong>Agent message</strong><span title={senderThreadId}>From thread {senderThreadId.slice(0, 8)}</span></span>
    </summary>
    <div className="step-detail">{children}</div>
  </details>;
}
