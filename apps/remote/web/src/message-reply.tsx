import { useState } from "react";
import type { MessageIdentity, MessageReply } from "../../server/message-protocol";
import "./message-reply.css";

export interface ReplyTarget { identity: MessageIdentity; text: string }

export function replyTarget(identity: MessageIdentity, text: string): ReplyTarget { return { identity, text }; }

/** Quoted content is carried by the reply. It remains useful if the original is outside the loaded window. */
export function ReplyQuote({ reply }: { reply: MessageReply }) {
  const [missing, setMissing] = useState(false);
  const jump = (event: React.MouseEvent<HTMLButtonElement>) => {
    const id = reply.messageId;
    const root = event.currentTarget.closest(".transcript");
    const original = id && [...(root?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])].find(element => element.dataset.messageId === id);
    if (!original) { setMissing(true); return; }
    setMissing(false);
    original.scrollIntoView({ behavior: "smooth", block: "center" });
    original.focus({ preventScroll: true });
    original.classList.remove("reply-highlight");
    void original.offsetWidth;
    original.classList.add("reply-highlight");
  };
  return <div className="reply-quote">
    <button type="button" className="reply-quote-link" onClick={jump} aria-label={`Go to message from ${reply.sender.name || reply.sender.id}`}>
      <strong>{reply.sender.name || reply.sender.id}</strong>
      <span>{reply.text || "Attachment"}</span>
    </button>
    {missing && <span className="reply-missing" role="status">Original message isn't loaded here.</span>}
  </div>;
}

export function ReplyComposer({ target, onCancel }: { target: ReplyTarget; onCancel(): void }) {
  return <div className="reply-composer" role="status">
    <div><strong>Replying to {target.identity.sender.name || target.identity.sender.id}</strong><span>{target.text || "Attachment"}</span></div>
    <button type="button" aria-label="Cancel reply" title="Cancel reply" onClick={onCancel}>×</button>
  </div>;
}
