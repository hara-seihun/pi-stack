import { useEffect, useId, useRef, type ReactNode } from "react";
import "./sheet.css";

export function Sheet({ open, title, onClose, children, actions, wide = false, labelledBy, variant = "modal" }: {
  open: boolean;
  title: ReactNode;
  onClose(): void;
  children: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
  labelledBy?: string;
  variant?: "modal" | "sidebar";
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const generatedId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (variant === "sidebar") element.show();
      else element.showModal();
    } else if (!open && element.open) element.close();
    return () => { if (element.open) element.close(); };
  }, [open, variant]);
  useEffect(() => {
    if (!open || variant !== "sidebar") return;
    const onPointerDown = (event: PointerEvent) => {
      if (!dialog.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, variant, onClose]);
  const close = (restoreFocus = false) => {
    onClose();
    if (restoreFocus) requestAnimationFrame(() => opener.current?.focus());
  };
  const id = labelledBy ?? generatedId;
  return <dialog ref={dialog} className={`sheet${wide ? " wide" : ""}${variant === "sidebar" ? " sheet-sidebar" : ""}`} aria-labelledby={id} onCancel={event => { event.preventDefault(); close(true); }} onClick={event => { if (event.target === dialog.current && variant === "modal") close(); }}>
    <div className="sheet-frame">
      <header className="sheet-header">
        <h2 id={id} className="sheet-title">{title}</h2>
        <div className="sheet-actions">{actions}<button type="button" className="sheet-close" aria-label="Close" onClick={() => close(true)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button></div>
      </header>
      <div className="sheet-body">{children}</div>
    </div>
  </dialog>;
}
