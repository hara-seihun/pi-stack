import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { drawingImage } from "./drawing-drafts";
import { ReadingAnchor } from "./scroll-position";
import { ScrollPositionBoundary, ScrollPositionContext } from "./scroll-boundary";
import type { ChatDrawing } from "./chat-drawing";

export const SCROLL_GESTURE_IDLE_MS = 180;

export function ConversationView({ active, label, drawing, editImages = true, transcript, children, newerAvailable = false, onJumpLatest, sentPromptId }: {
  active: boolean;
  label: string;
  drawing: ChatDrawing;
  editImages?: boolean;
  transcript: ReactNode;
  children?: ReactNode;
  newerAvailable?: boolean;
  onJumpLatest?(): void;
  sentPromptId?: string;
}) {
  const scrollback = useRef<HTMLDivElement>(null);
  const anchor = useRef<ReadingAnchor | null>(null);
  anchor.current ??= new ReadingAnchor();
  const owner = useMemo(() => ({ active, scroller: scrollback, anchor: anchor.current! }), [active]);
  const [away, setAway] = useState(false);
  const gesture = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const scroller = scrollback.current;
    if (!scroller || !active) return;
    const position = owner.anchor;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const pointers = new Set<number>();
    let touching = false;
    const settle = () => {
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => {
        idle = null;
        if (pointers.size || touching) return;
        setAway(position.endInteraction(scroller));
      }, SCROLL_GESTURE_IDLE_MS);
    };
    const begin = () => { position.beginInteraction(scroller); settle(); };
    gesture.current = begin;
    const pointerDown = (event: PointerEvent) => { pointers.add(event.pointerId); begin(); };
    const pointerEnd = (event: PointerEvent) => { if (pointers.delete(event.pointerId)) settle(); };
    const touchStart = () => { touching = true; begin(); };
    const touchEnd = (event: TouchEvent) => { if (!touching) return; touching = event.touches.length > 0; settle(); };
    const releaseContacts = () => { pointers.clear(); touching = false; settle(); };
    const key = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) begin();
    };
    scroller.addEventListener("wheel", begin, { passive: true });
    scroller.addEventListener("pointerdown", pointerDown, { passive: true });
    scroller.addEventListener("touchstart", touchStart, { passive: true });
    scroller.addEventListener("keydown", key);
    window.addEventListener("pointerup", pointerEnd, { passive: true });
    window.addEventListener("pointercancel", pointerEnd, { passive: true });
    window.addEventListener("touchend", touchEnd, { passive: true });
    window.addEventListener("touchcancel", touchEnd, { passive: true });
    window.addEventListener("blur", releaseContacts);
    position.afterResize(scroller);
    const observer = new ResizeObserver(() => position.afterResize(scroller));
    observer.observe(scroller);
    observer.observe(scroller.querySelector(".scroll-content")!);
    return () => {
      if (idle !== null) clearTimeout(idle);
      gesture.current = null;
      position.pause(scroller);
      observer.disconnect();
      scroller.removeEventListener("wheel", begin);
      scroller.removeEventListener("pointerdown", pointerDown);
      scroller.removeEventListener("touchstart", touchStart);
      scroller.removeEventListener("keydown", key);
      window.removeEventListener("pointerup", pointerEnd);
      window.removeEventListener("pointercancel", pointerEnd);
      window.removeEventListener("touchend", touchEnd);
      window.removeEventListener("touchcancel", touchEnd);
      window.removeEventListener("blur", releaseContacts);
    };
  }, [owner]);
  useLayoutEffect(() => {
    if (!sentPromptId || !active || !scrollback.current) return;
    owner.anchor.jumpLatest(scrollback.current);
    setAway(false);
  }, [sentPromptId, owner, active]);
  const editImage = (event: SyntheticEvent) => {
    if (!editImages || !active) return;
    const image = drawingImage(event.target);
    if (!image) return;
    event.preventDefault();
    event.stopPropagation();
    drawing.editImage(image);
  };
  const jump = () => {
    if (newerAvailable) onJumpLatest?.();
    if (scrollback.current) owner.anchor.jumpLatest(scrollback.current);
    setAway(false);
  };
  return <section hidden={!active} className={`conversation${drawing.isOpen ? " is-drawing" : ""}`} aria-label={label}>
    <div className="scrollback-frame">
    <div className={`scrollback${away ? " is-reading" : ""}`} ref={scrollback} onScroll={event => {
      if (!active) return;
      const result = owner.anchor.onScroll(event.currentTarget);
      if (!result.programmatic) gesture.current?.();
      setAway(result.reading);
    }} onClickCapture={editImage} onKeyDownCapture={event => { if (event.key === "Enter" || event.key === " ") editImage(event); }}>
      <ScrollPositionContext.Provider value={owner}>
        <ScrollPositionBoundary owner={owner}><div className="scroll-content">{transcript}</div></ScrollPositionBoundary>
      </ScrollPositionContext.Provider>
    </div>
    {(away || newerAvailable) && !drawing.isOpen && <button type="button" className="jump-latest" aria-label="Jump to latest" onClick={jump}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14m-6-6 6 6 6-6" /></svg></button>}
    </div>
    {drawing.editors}
    {children}
  </section>;
}
