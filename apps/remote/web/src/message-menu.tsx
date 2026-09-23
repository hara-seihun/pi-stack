import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./message-menu.css";

export interface MessageMenuItem {
  label: string;
  onSelect(): unknown;
  danger?: boolean;
}

interface Anchor { x: number; y: number }

/** Opens on a long press (touch) or a right click, so message text stays
 * selectable by ordinary drag on desktop while the phone gets one gesture. */
export function useMessageMenu(items: MessageMenuItem[] | undefined) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<Anchor | null>(null);
  const cancel = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } start.current = null; };
  useEffect(() => cancel, []);
  if (!items?.length) return { menu: null, handlers: {} };
  const handlers = {
    onContextMenu(event: React.MouseEvent) {
      if (window.getSelection()?.toString()) return;
      event.preventDefault();
      cancel();
      setAnchor({ x: event.clientX, y: event.clientY });
    },
    onPointerDown(event: React.PointerEvent) {
      if (event.pointerType !== "touch" || event.button !== 0) return;
      cancel();
      start.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => { if (start.current) setAnchor(start.current); cancel(); }, 450);
    },
    onPointerMove(event: React.PointerEvent) {
      if (start.current && Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
  };
  // Portaled: messages use content-visibility, whose paint containment would
  // trap a fixed-position menu inside the message box.
  const menu = anchor ? createPortal(<MessageMenu anchor={anchor} items={items} onClose={() => setAnchor(null)} />, document.body) : null;
  return { menu, handlers };
}

function MessageMenu({ anchor, items, onClose }: { anchor: Anchor; items: MessageMenuItem[]; onClose(): void }) {
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Anchor>(anchor);
  const phone = !matchMedia("(min-width: 900px)").matches;
  useLayoutEffect(() => {
    const box = element.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({ x: Math.max(8, Math.min(anchor.x, innerWidth - box.width - 8)), y: Math.max(8, Math.min(anchor.y, innerHeight - box.height - 8)) });
    element.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [anchor]);
  useEffect(() => {
    const close = () => onClose();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const pointer = (event: PointerEvent) => { if (!element.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", pointer, true);
    window.addEventListener("resize", close);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", pointer, true); window.removeEventListener("resize", close); };
  }, [onClose]);
  return <div ref={element} className={`message-menu${phone ? " bottom" : ""}`} role="menu" style={phone ? undefined : { left: position.x, top: position.y }}>
    {items.map(item => <button key={item.label} type="button" role="menuitem" className={item.danger ? "danger" : ""} onClick={() => { onClose(); void item.onSelect(); }}>{item.label}</button>)}
    {phone && <button type="button" className="message-menu-cancel" onClick={onClose}>Cancel</button>}
  </div>;
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { return false; }
}

