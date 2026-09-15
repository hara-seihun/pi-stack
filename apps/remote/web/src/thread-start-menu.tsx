import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion, useIsPresent, type HTMLMotionProps } from "motion/react";
import { API } from "../../server/api";
import { api } from "./client";
import { DismissibleError } from "./dismissible-error";
import { threadStartReducer, threadStartSelection, threadStartStage, type ThreadStartEvent, type ThreadStartState } from "./thread-start-state";
import type { ThreadStart } from "./types";

function iconFace(icon: string) {
  return /\p{Extended_Pictographic}/u.test(icon)
    ? <span className="model-emoji" aria-hidden="true">{icon}</span>
    : <img src={`/${icon}.svg`} alt="" draggable={false} />;
}

function darkGlyph(accent = "#89b4fa") {
  if (!/^#[0-9a-f]{6}$/i.test(accent)) return true;
  const [red, green, blue] = [1, 3, 5].map((at) => parseInt(accent.slice(at, at + 2), 16));
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 >= 0.5;
}

function MenuButton({ disabled, style, ...props }: HTMLMotionProps<"button">) {
  const present = useIsPresent();
  return <motion.button {...props} data-thread-start-button={present || undefined} disabled={disabled || !present} style={{ ...style, ...(!present ? { pointerEvents: "none" } : {}) }} />;
}

export function ThreadStartMenu({ starts, onCreated, onSettled }: { starts: ThreadStart[]; onCreated(id: string): void; onSettled(): void }) {
  const root = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ThreadStartState>({ kind: "closed" });
  const current = useRef(state);
  const dispatch = useCallback((event: ThreadStartEvent) => {
    current.current = threadStartReducer(current.current, event);
    setState(current.current);
  }, []);
  const selection = threadStartSelection(state);
  const chosen = selection?.kind === "models" ? selection.destination : null;
  const open = state.kind !== "closed";
  const busy = state.kind === "creating";
  const choices = chosen?.models ?? selection?.starts ?? [];
  const stage = threadStartStage(selection);
  const origin = selection?.kind === "models" ? selection.origin : 0;
  const size = Math.max(34, Math.min(42, Math.floor((310 - 12 * Math.max(0, choices.length - 1)) / Math.max(1, choices.length))));
  const target = (index: number) => -(choices.length - 1 - index) * (size + 12);
  const request = state.kind === "creating" ? state.request : null;

  useEffect(() => {
    if (!open) return;
    const onOutsidePress = (event: PointerEvent | MouseEvent) => {
      const button = event.target instanceof Element ? event.target.closest("button[data-thread-start-button], button.dismissible-error-dismiss") : null;
      if (button && root.current?.contains(button)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "click") dispatch({ type: "dismiss" });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dispatch({ type: "dismiss" });
    };
    document.addEventListener("pointerdown", onOutsidePress, true);
    document.addEventListener("click", onOutsidePress, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onOutsidePress, true);
      document.removeEventListener("click", onOutsidePress, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, dispatch]);

  useEffect(() => {
    if (!request) return;
    let active = true;
    const ownsRequest = () => active && current.current.kind === "creating" && current.current.request === request;
    void api(API.createSession.method, API.createSession.path(), request).then(() => {
      if (ownsRequest()) {
        dispatch({ type: "created", requestId: request.requestId });
        onCreated(request.sessionId);
      }
    }, (error: unknown) => {
      if (ownsRequest()) dispatch({ type: "failed", requestId: request.requestId, error: error instanceof Error ? error.message : String(error) });
    }).finally(onSettled);
    return () => { active = false; };
  }, [request, onCreated, onSettled, dispatch]);

  const shapeTransition = { type: "spring" as const, stiffness: 390, damping: 18, mass: 0.8 };
  const faceTransition = { type: "spring" as const, stiffness: 650, damping: 28, mass: 0.7 };
  return <MotionConfig reducedMotion="user"><div ref={root} className={`new-thread-buttons react-thread-start${open ? " expanded" : ""}`} aria-busy={busy} onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) dispatch({ type: "dismiss" }); }}>
    <svg className="motion-definitions" aria-hidden="true"><defs><filter id="thread-goo" x="-40%" y="-240%" width="180%" height="580%" colorInterpolationFilters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blurred" /><feColorMatrix in="blurred" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -10" /></filter></defs></svg>
    <div className="new-thread-shapes">
      <AnimatePresence initial={false}>
        {!open && <motion.span key="trigger-shape" className="thread-start-shape trigger" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={shapeTransition} />}
        {open && choices.map((choice, index) => <motion.span key={`${stage}:${choice.id}:shape`} className="thread-start-shape" style={{ width: size, height: size, marginTop: -size / 2, background: choice.accent || "var(--accent)" }} initial={{ x: origin, scale: 0 }} animate={{ x: target(index), y: 0, scale: 1 }} exit={{ x: open ? target(index) : 0, y: chosen ? 110 : 0, scale: 0 }} transition={{ ...shapeTransition, delay: index * 0.04 }} />)}
      </AnimatePresence>
    </div>
    <div className="new-thread-faces">
      <AnimatePresence initial={false}>
        {!open && <MenuButton key="trigger-face" type="button" className="provider-button trigger" aria-label="New thread" aria-expanded={false} disabled={!starts.length} initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0, opacity: 0 }} transition={faceTransition} onClick={() => dispatch({ type: "open", starts })} whileTap={{ scale: 0.86 }}><span className="glyph" /></MenuButton>}
        {open && choices.map((choice, index) => {
          const label = chosen ? `Start a ${chosen.label} thread on ${choice.label}` : selection?.starts.find((start) => start.id === choice.id)?.models.length ? `${choice.label} threads` : `Start a ${choice.label} thread`;
          return <MenuButton key={`${stage}:${choice.id}:face`} type="button" className="provider-button" disabled={busy || state.kind === "failed"} style={{ width: size, height: size, marginTop: -size / 2 }} aria-label={label} title={label} initial={{ x: origin, scale: 0, opacity: 0 }} animate={{ x: target(index), y: 0, scale: 1, opacity: 1 }} exit={{ x: open ? target(index) : 0, y: chosen ? 110 : 0, scale: 0, opacity: 0 }} transition={{ ...faceTransition, delay: index * 0.04 }} whileTap={{ scale: 0.84 }} onClick={() => dispatch({ type: "choose", stage, id: choice.id, origin: target(index), requestId: crypto.randomUUID(), sessionId: crypto.randomUUID() })}><span className={`glyph${darkGlyph(choice.accent) ? " dark" : ""}`}>{iconFace(choice.icon)}</span></MenuButton>;
        })}
      </AnimatePresence>
    </div>
    {(busy || state.kind === "failed") && <div className="thread-start-status">
      {busy && <span role="status">Creating thread…</span>}
      {state.kind === "failed" && <><DismissibleError message={state.error} dismissLabel="Dismiss thread creation error" /><button type="button" data-thread-start-button onClick={() => dispatch({ type: "retry" })}>Retry</button></>}
    </div>}
  </div></MotionConfig>;
}
