import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

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
    <form className="composer" onSubmit={event => { event.preventDefault(); if (!disabled) onSend(); }}>
      {before}
      <textarea ref={textarea} id={id} className="composer-prompt" aria-label={placeholder} rows={1} maxLength={200000} placeholder={placeholder} value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && matchMedia("(hover: hover) and (pointer: fine)").matches) {
          event.preventDefault();
          if (!disabled) onSend();
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
        <span className="composer-spacer" />{actions}
        <button id={id ? "action" : undefined} className={`composer-icon send${action === "stop" ? " abort" : action === "resume" ? " resume" : ""}`} type="submit" disabled={disabled} aria-label={action === "send" ? "Send message" : action === "stop" ? "Stop thread" : "Resume held messages"} title={action === "resume" ? "Resume: send the held messages" : undefined}>
          <svg className="send-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 9-18 9 4-9-4-9Zm4 9h14"/></svg>
          <svg className="stop-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
          <svg className="resume-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5-12-7.5Z"/></svg>
        </button>
      </div>
    </form>
  </>;
}
