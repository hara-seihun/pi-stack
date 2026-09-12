import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { DrawingColourPicker } from "./DrawingColourPicker";
import { grabPaper, paperPoint, screenRadius, zoomPaper, type PaperSize, type PaperView, type Point } from "./drawing-paper";
import "./drawing-canvas.css";

export type DrawingAttachmentResult = { ok: true } | { ok: false; error: string };
export interface DrawingCanvasProps {
  onAttach(file: File): Promise<DrawingAttachmentResult>;
  onClose(): void;
}

type Stroke = { color: string; radius: number; points: Point[] };
type Gesture = { kind: "stroke"; id: number; stroke: Stroke }
  | { kind: "paper"; ids: [number, number]; points: [Point, Point]; view: PaperView }
  | { kind: "waiting" } | null;

function paintStroke(context: CanvasRenderingContext2D, stroke: Stroke) {
  const first = stroke.points[0];
  context.fillStyle = stroke.color;
  context.strokeStyle = stroke.color;
  context.lineWidth = stroke.radius * 2;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  if (stroke.points.length === 1) {
    context.arc(first.x, first.y, stroke.radius, 0, Math.PI * 2);
    context.fill();
  } else {
    context.moveTo(first.x, first.y);
    for (let index = 1; index < stroke.points.length; index++) {
      context.lineTo(stroke.points[index].x, stroke.points[index].y);
    }
    context.stroke();
  }
}

function paintPaper(context: CanvasRenderingContext2D, paper: PaperSize, strokes: Stroke[], active?: Stroke) {
  context.save();
  context.beginPath();
  context.rect(-paper.width / 2, -paper.height / 2, paper.width, paper.height);
  context.clip();
  context.fillStyle = "#fff";
  context.fillRect(-paper.width / 2, -paper.height / 2, paper.width, paper.height);
  for (const stroke of strokes) paintStroke(context, stroke);
  if (active) paintStroke(context, active);
  context.restore();
}

function exportDrawing(paper: PaperSize, strokes: Stroke[]): Promise<{ ok: true; file: File } | { ok: false; error: string }> {
  return new Promise(resolve => {
    try {
      const canvas = document.createElement("canvas");
      const resolution = 2;
      canvas.width = Math.ceil(paper.width * resolution);
      canvas.height = Math.ceil(paper.height * resolution);
      const context = canvas.getContext("2d");
      if (!context) { resolve({ ok: false, error: "This browser could not create the drawing image." }); return; }
      context.scale(resolution, resolution);
      context.translate(paper.width / 2, paper.height / 2);
      paintPaper(context, paper, strokes);
      canvas.toBlob(blob => {
        if (!blob) { resolve({ ok: false, error: "This browser could not create a PNG." }); return; }
        const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
        resolve({ ok: true, file: new File([blob], `pi-drawing-${timestamp}.png`, { type: "image/png" }) });
      }, "image/png");
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export function DrawingCanvas({ onAttach, onClose }: DrawingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<PaperSize | null>(null);
  const viewportRef = useRef<PaperSize>({ width: 0, height: 0 });
  const viewRef = useRef<PaperView>({ x: 0, y: 0, scale: 1, angle: 0 });
  const strokesRef = useRef<Stroke[]>([]);
  const gestureRef = useRef<Gesture>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const cursorRef = useRef<Point | null>(null);
  const frameRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const [color, setColor] = useState("#202124");
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const render = useCallback(() => {
    frameRef.current = null;
    const canvas = canvasRef.current;
    const paper = paperRef.current;
    if (!canvas || !paper) return;
    const context = canvas.getContext("2d");
    if (!context) { setError("This browser could not open the drawing canvas."); return; }
    const viewport = viewportRef.current;
    const view = viewRef.current;
    context.setTransform(canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0);
    context.fillStyle = "#dadde1";
    context.fillRect(0, 0, viewport.width, viewport.height);
    context.save();
    context.translate(view.x, view.y);
    context.rotate(view.angle);
    context.scale(view.scale, view.scale);
    const gesture = gestureRef.current;
    paintPaper(context, paper, strokesRef.current, gesture?.kind === "stroke" ? gesture.stroke : undefined);
    context.restore();
    const cursor = cursorRef.current;
    if (cursor) {
      context.beginPath();
      context.arc(cursor.x, cursor.y, screenRadius(viewport), 0, Math.PI * 2);
      context.strokeStyle = "#fff";
      context.lineWidth = 3;
      context.stroke();
      context.strokeStyle = "#333";
      context.lineWidth = 1;
      context.stroke();
    }
  }, []);

  const redraw = useCallback(() => {
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(render);
  }, [render]);

  const resetPointers = useCallback(() => {
    gestureRef.current = null;
    pointersRef.current.clear();
    cursorRef.current = null;
    redraw();
  }, [redraw]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current!;
    const surface = surfaceRef.current!;
    const resize = () => {
      const bounds = surface.getBoundingClientRect();
      if (!bounds.width || !bounds.height) { resetPointers(); return; }
      const width = bounds.width;
      const height = bounds.height;
      const previous = viewportRef.current;
      if (!paperRef.current) paperRef.current = { width, height };
      viewRef.current = { ...viewRef.current, x: viewRef.current.x + (width - previous.width) / 2, y: viewRef.current.y + (height - previous.height) / 2 };
      viewportRef.current = { width, height };
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      resetPointers();
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (busyRef.current || pointersRef.current.size) return;
      const bounds = canvas.getBoundingClientRect();
      const anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportRef.current.height : 1;
      const exponent = Math.max(-2, Math.min(2, -event.deltaY * unit * (event.ctrlKey ? 0.01 : 0.002)));
      viewRef.current = zoomPaper(viewRef.current, anchor, Math.exp(exponent));
      redraw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(surface);
    canvas.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("blur", resetPointers);
    resize();
    return () => {
      observer.disconnect();
      canvas.removeEventListener("wheel", wheel);
      window.removeEventListener("blur", resetPointers);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [redraw, resetPointers]);

  const localPoint = (clientX: number, clientY: number): Point => {
    const bounds = canvasRef.current!.getBoundingClientRect();
    return { x: clientX - bounds.left, y: clientY - bounds.top };
  };

  const grab = () => {
    const [first, second] = [...pointersRef.current.entries()];
    gestureRef.current = second
      ? { kind: "paper", ids: [first[0], second[0]], points: [first[1], second[1]], view: { ...viewRef.current } }
      : pointersRef.current.size ? { kind: "waiting" } : null;
    cursorRef.current = null;
    redraw();
  };

  const start = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (busyRef.current || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = localPoint(event.clientX, event.clientY);
    pointersRef.current.set(event.pointerId, point);
    if (pointersRef.current.size > 1) { grab(); return; }
    const paper = paperRef.current;
    if (!paper) return;
    const position = paperPoint(point, viewRef.current);
    if (Math.abs(position.x) > paper.width / 2 || Math.abs(position.y) > paper.height / 2) {
      gestureRef.current = { kind: "waiting" };
      return;
    }
    setError(null);
    gestureRef.current = { kind: "stroke", id: event.pointerId, stroke: {
      color, radius: screenRadius(viewportRef.current) / viewRef.current.scale, points: [position],
    } };
    cursorRef.current = event.pointerType === "mouse" ? point : null;
    redraw();
  };

  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = localPoint(event.clientX, event.clientY);
    if (event.pointerType === "mouse") { cursorRef.current = point; redraw(); }
    if (!pointersRef.current.has(event.pointerId)) return;
    event.preventDefault();
    pointersRef.current.set(event.pointerId, point);
    const gesture = gestureRef.current;
    if (gesture?.kind === "paper") {
      const first = pointersRef.current.get(gesture.ids[0]);
      const second = pointersRef.current.get(gesture.ids[1]);
      if (first && second) viewRef.current = grabPaper(gesture.view, gesture.points, [first, second]);
      redraw();
    } else if (gesture?.kind === "stroke" && gesture.id === event.pointerId) {
      const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
      for (const sample of samples.length ? samples : [event.nativeEvent]) {
        const next = paperPoint(localPoint(sample.clientX, sample.clientY), viewRef.current);
        const previous = gesture.stroke.points.at(-1)!;
        if (Math.hypot(next.x - previous.x, next.y - previous.y) * viewRef.current.scale >= 0.25) gesture.stroke.points.push(next);
      }
      redraw();
    }
  };

  const finish = (event: ReactPointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.delete(event.pointerId);
    const gesture = gestureRef.current;
    if (gesture?.kind === "stroke" && gesture.id === event.pointerId && !cancelled) {
      const next = paperPoint(localPoint(event.clientX, event.clientY), viewRef.current);
      const previous = gesture.stroke.points.at(-1)!;
      if (next.x !== previous.x || next.y !== previous.y) gesture.stroke.points.push(next);
      strokesRef.current.push(gesture.stroke);
    }
    grab();
  };

  const done = async () => {
    if (busyRef.current) return;
    resetPointers();
    if (!strokesRef.current.length) { onClose(); return; }
    const paper = paperRef.current;
    if (!paper) return;
    busyRef.current = true;
    setAttaching(true);
    setError(null);
    const result = await exportDrawing(paper, strokesRef.current);
    if (!result.ok) setError(result.error);
    else {
      const uploaded = await onAttach(result.file);
      if (!uploaded.ok) setError(uploaded.error);
      else onClose();
    }
    busyRef.current = false;
    setAttaching(false);
  };

  return <section className="drawing-canvas" aria-label="Drawing editor">
    <div ref={surfaceRef} className="drawing-surface">
      <canvas ref={canvasRef} aria-label="Drawing paper. Drag to draw. Use two fingers to move, zoom and rotate the paper."
        onPointerDown={start} onPointerMove={move} onPointerUp={event => finish(event, false)}
        onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
        onPointerLeave={() => { cursorRef.current = null; redraw(); }} onContextMenu={event => event.preventDefault()} />
    </div>
    <button type="button" className="drawing-done drawing-exit" aria-label="Cancel drawing" title="Cancel drawing" disabled={attaching} onClick={() => { resetPointers(); setError(null); onClose(); }}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
    </button>
    <div className="drawing-controls">
      <DrawingColourPicker color={color} onChange={setColor} disabled={attaching} />
      <button type="button" className="drawing-done" onClick={() => void done()} disabled={attaching}>{attaching ? "Saving…" : "Done"}</button>
    </div>
    {error && <div className="drawing-error" role="alert">{error}</div>}
  </section>;
}
