import { useEffect, useRef, useState } from "react";
import { API } from "../../server/api";
import type { MessageIdentity, MessageReaction, ReactionRequest } from "../../server/message-protocol";
import { piFetch } from "./client";
import { DismissibleError } from "./dismissible-error";

const emptyReactions: MessageReaction[] = [];
const choices = ["👍", "❤️", "😂", "🎉", "😮", "😢"];

async function saveReaction(request: ReactionRequest, signal: AbortSignal): Promise<{ ok: true; reactions: MessageReaction[] } | { ok: false; message: string }> {
  try {
    const response = await piFetch(API.messageReaction.path(), {
      method: API.messageReaction.method,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
      cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true || !Array.isArray(result.reactions)) {
      return { ok: false, message: typeof result.error?.message === "string" ? result.error.message : `Could not save reaction (HTTP ${response.status})` };
    }
    return { ok: true, reactions: result.reactions };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not save reaction" };
  }
}

export function MessageReactions({ identity, reactions = emptyReactions, open, onOpenChange: setOpen }: { identity: MessageIdentity; reactions?: MessageReaction[]; open: boolean; onOpenChange(open: boolean): void }) {
  const [current, setCurrent] = useState(reactions);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => { setCurrent(reactions); }, [identity.id, reactions]);
  useEffect(() => {
    setOpen(false);
    setError("");
    setPending(false);
    controller.current?.abort();
  }, [identity.id]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!open) return;
    container.current?.querySelector<HTMLButtonElement>(".message-reaction-picker button")?.focus();
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      container.current?.closest<HTMLElement>("[data-message-id]")?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const viewer = typeof window === "undefined" ? "" : window.PiRemotePerson.get();
  const isMine = (reaction: MessageReaction) => reaction.own === true || reaction.own === undefined && reaction.sender.id === viewer;
  const grouped = new Map<string, MessageReaction[]>();
  for (const reaction of current) grouped.set(reaction.emoji, [...(grouped.get(reaction.emoji) ?? []), reaction]);
  const toggle = async (emoji: string) => {
    if (!emoji || pending) return;
    const remove = current.some(reaction => reaction.emoji === emoji && isMine(reaction));
    const requestController = new AbortController();
    controller.current = requestController;
    setPending(true);
    setError("");
    const result = await saveReaction({ messageId: identity.id, emoji, ...(remove ? { remove: true } : {}) }, requestController.signal);
    if (requestController.signal.aborted) return;
    setPending(false);
    if (result.ok) { setCurrent(result.reactions); setOpen(false); setCustom(""); }
    else setError(result.message);
  };

  if (!grouped.size && !open && !error) return null;
  return <div ref={container} className="message-reactions" aria-label={`Reactions to ${identity.sender.name || identity.sender.id}'s message`}>
    {Array.from(grouped, ([emoji, senders]) => {
      const mine = senders.some(isMine);
      const names = senders.map(reaction => reaction.sender.name || reaction.sender.id).join(", ");
      return <span key={emoji} className="message-reaction-chip" aria-label={`${emoji}, ${senders.length} ${senders.length === 1 ? "reaction" : "reactions"} from ${names}`} data-own={mine || undefined} title={names}>{emoji} <span>{senders.length}</span></span>;
    })}
    {open && <div className="message-reaction-picker" role="group" aria-label="Choose a reaction" onPointerDown={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
      {Array.from(new Set([...choices, ...current.filter(isMine).map(reaction => reaction.emoji)])).map(emoji => <button key={emoji} type="button" aria-label={`${current.some(reaction => reaction.emoji === emoji && isMine(reaction)) ? "Remove" : "React with"} ${emoji}`} aria-pressed={current.some(reaction => reaction.emoji === emoji && isMine(reaction))} disabled={pending} onClick={() => void toggle(emoji)}>{emoji}</button>)}
      <form onSubmit={event => { event.preventDefault(); void toggle(custom.trim()); }}>
        <input type="text" aria-label="Other emoji" placeholder="Other emoji" value={custom} onChange={event => setCustom(event.target.value)} maxLength={16} />
        <button type="submit" disabled={!custom.trim() || pending}>React</button>
      </form>
    </div>}
    <DismissibleError className="message-reaction-error" message={error} dismissLabel="Dismiss reaction error" onDismiss={async () => { setError(""); return { ok: true }; }} />
  </div>;
}
