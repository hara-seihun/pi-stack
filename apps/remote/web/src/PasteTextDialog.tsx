import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { DismissibleError } from "./dismissible-error";

export function PasteTextDialog({ name, content, onNameChange, onContentChange, onAttach, onClose }: {
  name: string;
  content: string;
  onNameChange(name: string): void;
  onContentChange(content: string): void;
  onAttach(file: File): Promise<{ ok: true } | { ok: false; error: string }>;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  const attach = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current || !content.trim() || !name.trim()) return;
    submitting.current = true;
    setPending(true);
    setError("");
    const filename = /\.[^./\\]+$/.test(name.trim()) ? name.trim() : `${name.trim()}.txt`;
    const result = await onAttach(new File([content], filename, { type: "text/plain;charset=utf-8" }));
    submitting.current = false;
    setPending(false);
    if (result.ok) {
      onContentChange("");
      onClose();
    } else setError(result.error);
  };

  return <dialog ref={dialog} className="paste-text-dialog" aria-labelledby="paste-text-title" onCancel={event => { event.preventDefault(); if (!submitting.current) onClose(); }}>
    <form className="paste-text-form" onSubmit={event => void attach(event)}>
      <h2 id="paste-text-title">Paste text document</h2>
      <label htmlFor="paste-text-name">Document name</label>
      <input id="paste-text-name" value={name} disabled={pending} onChange={event => onNameChange(event.target.value)} />
      <label htmlFor="paste-text-content">Text</label>
      <textarea id="paste-text-content" autoFocus value={content} disabled={pending} onChange={event => onContentChange(event.target.value)} />
      <DismissibleError message={error} dismissLabel="Dismiss upload error" />
      <div className="paste-text-actions">
        <button type="button" disabled={pending} onClick={onClose}>Cancel</button>
        <button className="accent" type="submit" disabled={pending || !content.trim() || !name.trim()}>{pending ? "Attaching…" : "Attach"}</button>
      </div>
    </form>
  </dialog>;
}
