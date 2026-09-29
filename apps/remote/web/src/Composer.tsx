import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { learnWrite, startWrite, type WriteRecording } from "./write-dictation";

export interface ComposerAttachment {
  id: string;
  name: string;
  uploading?: boolean;
}

export function Composer({ value, onChange, onSend, placeholder, disabled, readOnly = false, attachmentDisabled = false, attachments, onRemove, onUpload, onPaste, onDraw, action = "send", before, actions, id, layoutKey }: {
  value: string;
  onChange(value: string): void;
  onSend(): void;
  placeholder: string;
  disabled: boolean;
  readOnly?: boolean;
  attachmentDisabled?: boolean;
  attachments: ComposerAttachment[];
  onRemove(id: string): void;
  onUpload(files: File[]): void;
  onPaste(): void;
  onDraw(): void;
  action?: "send" | "stop" | "resume";
  before?: ReactNode;
  actions?: ReactNode;
  id?: string;
  layoutKey?: unknown;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [writeState, setWriteState] = useState<"idle" | "starting" | "recording" | "finishing">("idle");
  const [writeTail, setWriteTail] = useState("");
  const [writeError, setWriteError] = useState("");
  const recording = useRef<WriteRecording | null>(null);
  const finishWanted = useRef(false);
  const generation = useRef(0);
  const draft = useRef(value);
  draft.current = value;
  const span = useRef<{ start: number; end: number; inserted: string; final: boolean } | null>(null);
  const editTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const learn = () => {
    if (editTimer.current) clearTimeout(editTimer.current);
    const current = span.current;
    if (!current?.final) return;
    const corrected = draft.current.slice(current.start, current.end);
    if (corrected !== current.inserted) void learnWrite(current.inserted, corrected);
    span.current = null;
  };
  const setDraft = (next: string) => { draft.current = next; onChange(next); };
  const insert = (text: string) => {
    const current = span.current;
    if (!current) return;
    const next = draft.current.slice(0, current.start) + text + draft.current.slice(current.end);
    current.end = current.start + text.length;
    setDraft(next);
  };
  const stop = (cancel: boolean) => {
    if (cancel) generation.current++;
    else finishWanted.current = true;
    if (cancel && span.current && !span.current.final) insert("");
    if (cancel) span.current = null;
    if (editTimer.current) clearTimeout(editTimer.current);
    if (cancel) recording.current?.cancel(); else recording.current?.finish();
    recording.current = cancel ? null : recording.current;
    if (cancel) { finishWanted.current = false; setWriteTail(""); setWriteState("idle"); }
    else setWriteState("finishing");
  };
  const start = async () => {
    if (writeState !== "idle") return;
    learn();
    finishWanted.current = false;
    setWriteError(""); setWriteState("starting");
    const selection = textarea.current;
    const startAt = selection?.selectionStart ?? draft.current.length;
    const endAt = selection?.selectionEnd ?? startAt;
    if (endAt > startAt) setDraft(draft.current.slice(0, startAt) + draft.current.slice(endAt));
    span.current = { start: startAt, end: startAt, inserted: "", final: false };
    const ticket = ++generation.current;
    try {
      const result = await startWrite({ context: draft.current.slice(0, startAt),
        partial: (committed, tail) => { if (generation.current !== ticket) return; insert(committed); setWriteTail(tail); },
        final: text => { if (generation.current !== ticket) return; insert(text); if (span.current) { span.current.inserted = text; span.current.final = true; } recording.current = null; setWriteTail(""); setWriteState("idle"); },
        error: message => { if (generation.current !== ticket) return; setWriteError(message); recording.current = null; setWriteTail(""); setWriteState("idle"); },
      });
      if (generation.current !== ticket) result.cancel();
      else { recording.current = result; if (finishWanted.current) { result.finish(); setWriteState("finishing"); } else setWriteState("recording"); }
    } catch (error) { if (generation.current === ticket) { span.current = null; setWriteError(error instanceof Error ? error.message : String(error)); setWriteState("idle"); } }
  };
  useEffect(() => {
    setWriteState("idle"); setWriteTail(""); setWriteError("");
    return () => { generation.current++; recording.current?.cancel(); recording.current = null; span.current = null; if (editTimer.current) clearTimeout(editTimer.current); };
  }, [layoutKey]);
  const changed = (next: string) => {
    const current = span.current;
    if (current?.final) {
      const before = draft.current;
      let prefix = 0;
      while (prefix < before.length && prefix < next.length && before[prefix] === next[prefix]) prefix++;
      let suffix = 0;
      while (suffix < before.length - prefix && suffix < next.length - prefix && before[before.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
      const oldEnd = before.length - suffix;
      const newEnd = next.length - suffix;
      if (oldEnd <= current.start) { const delta = next.length - before.length; current.start += delta; current.end += delta; }
      else if (prefix < current.end) {
        current.end += next.length - before.length;
        if (prefix < current.start) current.start = prefix;
        if (editTimer.current) clearTimeout(editTimer.current);
        editTimer.current = setTimeout(learn, 800);
      }
      if (newEnd < current.start) current.end = current.start;
    }
    setDraft(next);
  };
  const fileInput = useRef<HTMLInputElement>(null);
  // Two entrances to the same upload. An `accept="image/*"` chooser is what
  // makes Android open the photo picker instead of the document browser.
  const imageInput = useRef<HTMLInputElement>(null);
  const chosen = (event: { target: HTMLInputElement }) => { onUpload([...event.target.files || []]); event.target.value = ""; };
  const resize = useCallback(() => {
    const element = textarea.current;
    if (!element || !element.getClientRects().length) return;
    element.style.height = "auto";
    const style = getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight) || (Number.parseFloat(style.fontSize) || 16) * 1.4;
    const chrome = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
      + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
    const maximum = lineHeight * 6 + chrome;
    element.style.height = `${Math.min(element.scrollHeight, maximum)}px`;
    element.style.overflowY = element.scrollHeight > maximum ? "auto" : "hidden";
  }, []);
  useLayoutEffect(resize, [value, resize, layoutKey]);
  useEffect(() => {
    window.addEventListener("resize", resize);
    let width = textarea.current?.clientWidth;
    const observer = new ResizeObserver(() => {
      if (textarea.current?.clientWidth === width) return;
      width = textarea.current?.clientWidth;
      resize();
    });
    if (textarea.current) observer.observe(textarea.current);
    return () => { window.removeEventListener("resize", resize); observer.disconnect(); };
  }, [resize]);
  return <>
    {attachments.length > 0 && <div className="attachments">{attachments.map(attachment => <div className={`attachment-chip${attachment.uploading ? " uploading" : ""}`} key={attachment.id}>
      <span className="attachment-name">{attachment.name}{attachment.uploading ? " · uploading" : ""}</span>
      <button className="attachment-remove" type="button" aria-label={`Remove ${attachment.name}`} disabled={readOnly || attachment.uploading} onClick={() => onRemove(attachment.id)}>×</button>
    </div>)}</div>}
    <form className="composer" onSubmit={event => { event.preventDefault(); if (!disabled && writeState === "idle") { learn(); onSend(); } }}>
      {before}
      <textarea ref={textarea} id={id} className="composer-prompt" aria-label={placeholder} rows={1} maxLength={200000} placeholder={placeholder} value={value} readOnly={readOnly} onChange={event => changed(event.target.value)} onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && matchMedia("(hover: hover) and (pointer: fine)").matches) {
          event.preventDefault();
          if (!disabled && writeState === "idle") { learn(); onSend(); }
        }
      }} />
      <div className="composer-actions">
        <button type="button" className="composer-icon" aria-label="Attach files" title="Attach files" disabled={readOnly || attachmentDisabled} onClick={() => fileInput.current?.click()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 6.5 8.7 14.3a2.5 2.5 0 0 0 3.5 3.5l8.1-8.1a4.5 4.5 0 0 0-6.4-6.4L5.5 11.7a6.5 6.5 0 0 0 9.2 9.2l6.1-6.1"/></svg>
        </button>
        <input ref={fileInput} type="file" multiple hidden disabled={readOnly || attachmentDisabled} onChange={chosen} />
        <button type="button" className="composer-icon" aria-label="Attach images" title="Attach images" disabled={readOnly || attachmentDisabled} onClick={() => imageInput.current?.click()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m3.5 16.5 5-4.5 3.5 3 3-2.5 5.5 4.5"/></svg>
        </button>
        <input ref={imageInput} type="file" accept="image/*" multiple hidden disabled={readOnly || attachmentDisabled} onChange={chosen} />
        <button className="composer-icon" type="button" aria-label="Paste text document" disabled={readOnly || attachmentDisabled} onClick={onPaste}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5.5V4h6v1.5M9 5.5h6M9 5.5H7v15h10v-15h-2M9 10h6m-6 4h6m-6 4h4"/></svg></button>
        <button className="composer-icon drawing-toggle" type="button" aria-label="Draw a picture" title="Draw a picture" disabled={readOnly || attachmentDisabled} onClick={onDraw}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 13 7-9a1.5 1.5 0 0 0-2-2l-9 7 4 4Z"/><path d="M10 9c-3-1-5 1-5 4 0 2-1 3-3 4 4 3 10 2 11-3l1-1"/></svg></button>
        <button type="button" className="composer-icon" aria-label={writeState === "idle" ? "Start dictation" : "Cancel dictation"} title={writeState === "idle" ? "Dictate" : "Cancel dictation"} disabled={readOnly} onClick={() => writeState === "idle" ? void start() : stop(true)}>{writeState === "idle" ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4m-4 0h8"/></svg> : "✗"}</button>
        {writeState !== "idle" && <button type="button" className="composer-icon" aria-label="Finish dictation" title="Finish dictation" disabled={writeState === "finishing"} onClick={() => stop(false)}>✓</button>}
        <span className="composer-spacer" />{actions}
        <button id={id ? "action" : undefined} className={`composer-icon send${action === "stop" ? " abort" : action === "resume" ? " resume" : ""}`} type="submit" disabled={disabled} aria-label={action === "send" ? "Send message" : action === "stop" ? "Stop thread" : "Resume held messages"} title={action === "resume" ? "Resume: send the held messages" : undefined}>
          <svg className="send-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 9-18 9 4-9-4-9Zm4 9h14"/></svg>
          <svg className="stop-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
          <svg className="resume-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5-12-7.5Z"/></svg>
        </button>
      </div>
      {writeTail && <span className="write-tail" role="status" aria-label="Unstable dictation">{writeTail}</span>}
      {writeError && <span className="write-error" role="alert">{writeError}</span>}
    </form>
  </>;
}
