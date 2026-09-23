import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { API } from "../../../../server/api";
import { THREAD_COLORS as COLOR_VALUES, type ThreadColor } from "../../../../server/protocol";
import { api } from "../../client";
import { DismissibleError } from "../../dismissible-error";
import "./thread-color.css";

const COLOR_STYLES: Record<ThreadColor, { label: string; hex: string }> = {
  red: { label: "Red / pink", hex: "#f07196" },
  orange: { label: "Orange", hex: "#ee9954" },
  yellow: { label: "Yellow", hex: "#e5c95c" },
  green: { label: "Green", hex: "#69bb8b" },
  blue: { label: "Blue", hex: "#66a9e8" },
  purple: { label: "Purple", hex: "#b48ade" },
};
const THREAD_COLORS = COLOR_VALUES.map(value => ({ value, ...COLOR_STYLES[value] }));
export function threadColorStyle(color?: ThreadColor | null): CSSProperties {
  return { "--thread-color": THREAD_COLORS.find(item => item.value === color)?.hex } as CSSProperties;
}

type Position = { left: number; top: number; originX: number; originY: number };
export function ThreadColorButton({ id, name, color, onPreview }: { id: string; name: string; color?: ThreadColor | null; onPreview(color: ThreadColor | null): void }) {
  const button = useRef<HTMLButtonElement>(null);
  const palette = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [position, setPosition] = useState<Position | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const latestColor = useRef(color);
  latestColor.current = color;
  const close = (focus = false) => { setOpen(false); if (focus) button.current?.focus(); };

  useEffect(() => {
    if (open || !position) return;
    const timer = window.setTimeout(() => setPosition(null), 240);
    return () => window.clearTimeout(timer);
  }, [open, position]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !palette.current?.contains(event.target) && !button.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(true); }
    };
    const moved = (event: Event) => { if (!(event.target instanceof Node) || !palette.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", moved);
    document.addEventListener("scroll", moved, true);
    const frame = requestAnimationFrame(() => palette.current?.querySelector<HTMLButtonElement>("button[aria-pressed=true], button")?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", moved);
      document.removeEventListener("scroll", moved, true);
    };
  }, [open]);

  const toggle = () => {
    if (open) return close();
    const rect = button.current!.getBoundingClientRect();
    const viewport = window.visualViewport;
    const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const left = Math.max(8, Math.min(rect.right - 224, width - 232));
    const top = rect.bottom + 232 <= height ? rect.bottom + 4 : Math.max(8, rect.top - 228);
    setPosition({ left, top, originX: x - left, originY: y - top });
    setOpen(true);
  };
  const choose = async (next: ThreadColor | null) => {
    if (busy) return;
    close(true);
    setBusy(true); setError(""); onPreview(next);
    try {
      await api(API.sessionColor.method, API.sessionColor.path({ sessionId: id }), { color: next });
    } catch (cause) {
      onPreview(latestColor.current ?? null);
      setError(`Could not save thread colour: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally { setBusy(false); }
  };
  return <>
    <button ref={button} type="button" className="thread-color-toggle" aria-label={`Thread colour for ${name}: ${color ?? "none"}`} title="Thread colour" aria-expanded={open} aria-controls={position ? menuId : undefined} disabled={busy} onClick={toggle}><span className="thread-color-dot" /></button>
    {position && createPortal(<div ref={palette} id={menuId} className={`thread-color-palette${open ? " is-open" : ""}`} role="group" aria-label={`Colour for ${name}`} inert={!open} style={{ left: position.left, top: position.top, "--origin-x": `${position.originX - 22}px`, "--origin-y": `${position.originY - 22}px` } as CSSProperties} onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== button.current) close(); }} onKeyDown={event => {
      if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      items[index]?.focus();
    }}>
      {THREAD_COLORS.map((item, index) => {
        const angle = (index * 60 - 90) * Math.PI / 180;
        return <button key={item.value} type="button" className="thread-color-option" aria-label={item.label} aria-pressed={color === item.value} title={item.label} disabled={busy} onClick={() => void choose(item.value)} style={{ "--swatch": item.hex, "--x": `${90 + 76 * Math.cos(angle)}px`, "--y": `${90 + 76 * Math.sin(angle)}px`, "--index": index } as CSSProperties}><span /></button>;
      })}
      <button type="button" className="thread-color-clear" title="Clear colour" aria-label="Clear thread colour" disabled={busy} onClick={() => void choose(null)}>×</button>
    </div>, document.body)}
    {error && <div className="thread-color-error"><DismissibleError message={error} /></div>}
  </>;
}
