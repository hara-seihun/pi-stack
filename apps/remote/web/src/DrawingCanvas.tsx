import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { DrawingColourPicker } from "./DrawingColourPicker";
import type { DrawingBackground } from "./drawing-drafts";
import { drawingExportSize, fitPaper, grabPaper, paperPoint, screenRadius, zoomPaper, type PaperSize, type PaperView, type Point } from "./drawing-paper";
import "./drawing-canvas.css";

export type DrawingAttachmentResult = { ok: true } | { ok: false; error: string };
export interface DrawingCanvasProps {
  onAttach(file: File): Promise<DrawingAttachmentResult>;
  onClose(): void;
  background?: DrawingBackground;
}

type Stroke = { color: string; radius: number; points: Point[] };
type BackgroundState = "loading" | "ready" | "failed";
type ExportResult = { ok: true; file: File } | { ok: false; error: string };
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

function paintPaper(context: CanvasRenderingContext2D, paper: PaperSize, strokes: Stroke[], active?: Stroke, background?: HTMLImageElement) {
  context.save();
  try {
    context.beginPath();
    context.rect(-paper.width / 2, -paper.height / 2, paper.width, paper.height);
    context.clip();
    if (background) context.drawImage(background, -paper.width / 2, -paper.height / 2, paper.width, paper.height);
    else {
      context.fillStyle = "#fff";
      context.fillRect(-paper.width / 2, -paper.height / 2, paper.width, paper.height);
    }
    for (const stroke of strokes) paintStroke(context, stroke);
    if (active) paintStroke(context, active);
  } finally {
    context.restore();
  }
}

function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function exportDrawing(paper: PaperSize, strokes: Stroke[], background?: HTMLImageElement): Promise<ExportResult> {
  return new Promise(resolve => {
    try {
      const canvas = document.createElement("canvas");
      const size = drawingExportSize(paper, Boolean(background));
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (!context) { resolve({ ok: false, error: "This browser could not create the drawing image." }); return; }
      const resolution = background ? 1 : 2;
      context.scale(resolution, resolution);
      context.translate(paper.width / 2, paper.height / 2);
      paintPaper(context, paper, strokes, undefined, background);
      canvas.toBlob(blob => {
        try {
          if (!blob) { resolve({ ok: false, error: "This browser could not create a PNG." }); return; }
          const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
          resolve({ ok: true, file: new File([blob], `pi-drawing-${timestamp}.png`, { type: "image/png" }) });
        } catch (error) {
          resolve({ ok: false, error: messageFrom(error, "This browser could not create a PNG.") });
        }
      }, "image/png");
    } catch (error) {
      resolve({ ok: false, error: messageFrom(error, "This browser could not export the drawing.") });
    }
  });
}

export function DrawingCanvas({ onAttach, onClose, background }: DrawingCanvasProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<PaperSize | null>(null);
  const viewInitializedRef = useRef(false);
  const backgroundRef = useRef<HTMLImageElement | null>(null);
  const backgroundWantedRef = useRef(Boolean(background));
  const backgroundKeyRef = useRef<string | null>(null);
  const viewportRef = useRef<PaperSize>({ width: 0, height: 0 });
  const viewRef = useRef<PaperView>({ x: 0, y: 0, scale: 1, angle: 0 });
  const strokesRef = useRef<Stroke[]>([]);
  const gestureRef = useRef<Gesture>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const cursorRef = useRef<Point | null>(null);
  const frameRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const operationRef = useRef(0);
  const [color, setColor] = useState("#202124");
  const [attaching, setAttaching] = useState(false);
  const [backgroundState, setBackgroundState] = useState<BackgroundState>(background ? "loading" : "ready");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [strokeCount, setStrokeCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  backgroundWantedRef.current = Boolean(background);

  const render = useCallback(() => {
    frameRef.current = null;
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport.width || !viewport.height) return;
    const context = canvas.getContext("2d");
    if (!context) { setError("This browser could not open the drawing canvas."); return; }
    context.setTransform(canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0);
    context.fillStyle = "#dadde1";
    context.fillRect(0, 0, viewport.width, viewport.height);
    const paper = paperRef.current;
    if (!paper) return;
    const view = viewRef.current;
    context.save();
    try {
      context.translate(view.x, view.y);
      context.rotate(view.angle);
      context.scale(view.scale, view.scale);
      const gesture = gestureRef.current;
      paintPaper(context, paper, strokesRef.current, gesture?.kind === "stroke" ? gesture.stroke : undefined, backgroundRef.current ?? undefined);
    } catch (renderError) {
      if (backgroundRef.current) {
        backgroundRef.current = null;
        setBackgroundState("failed");
        setError(messageFrom(renderError, "This browser could not display the background image."));
      } else {
        setError(messageFrom(renderError, "This browser could not draw on the canvas."));
      }
    } finally {
      context.restore();
    }
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busyRef.current || sectionRef.current?.closest("[hidden]")) return;
      event.preventDefault();
      operationRef.current += 1;
      resetPointers();
      onClose();
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [onClose, resetPointers]);

  useEffect(() => {
    let current = true;
    operationRef.current += 1;
    backgroundRef.current = null;
    const backgroundKey = background ? `${background.src}\u0000${background.alt}` : "";
    if (backgroundKeyRef.current !== backgroundKey) {
      backgroundKeyRef.current = backgroundKey;
      strokesRef.current = [];
      setStrokeCount(0);
    }
    resetPointers();
    setError(null);
    const viewport = viewportRef.current;
    viewRef.current = { x: viewport.width / 2, y: viewport.height / 2, scale: 1, angle: 0 };
    viewInitializedRef.current = false;

    if (!background) {
      paperRef.current = viewport.width && viewport.height ? { ...viewport } : null;
      if (paperRef.current) {
        viewRef.current = fitPaper(paperRef.current, viewport);
        viewInitializedRef.current = true;
      }
      setBackgroundState("ready");
      redraw();
      return () => { current = false; };
    }

    paperRef.current = null;
    setBackgroundState("loading");
    redraw();
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => {
      if (!current) return;
      if (!image.naturalWidth || !image.naturalHeight) {
        setBackgroundState("failed");
        setError(`Could not load ${background.alt || "the background image"}.`);
        redraw();
        return;
      }
      backgroundRef.current = image;
      paperRef.current = { width: image.naturalWidth, height: image.naturalHeight };
      const currentViewport = viewportRef.current;
      if (currentViewport.width && currentViewport.height) {
        viewRef.current = fitPaper(paperRef.current, currentViewport);
        viewInitializedRef.current = true;
      }
      setBackgroundState("ready");
      redraw();
    };
    image.onerror = () => {
      if (!current) return;
      backgroundRef.current = null;
      paperRef.current = null;
      setBackgroundState("failed");
      setError(`Could not load ${background.alt || "the background image"}.`);
      redraw();
    };
    image.src = background.src;
    return () => {
      current = false;
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
    };
  }, [background?.alt, background?.src, loadAttempt, redraw, resetPointers]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current!;
    const surface = surfaceRef.current!;
    const resize = () => {
      const bounds = surface.getBoundingClientRect();
      if (!bounds.width || !bounds.height) { resetPointers(); return; }
      const width = bounds.width;
      const height = bounds.height;
      const previous = viewportRef.current;
      const viewport = { width, height };
      if (!paperRef.current && !backgroundWantedRef.current) paperRef.current = viewport;
      if (paperRef.current && !viewInitializedRef.current) {
        viewRef.current = fitPaper(paperRef.current, viewport);
        viewInitializedRef.current = true;
      } else {
        viewRef.current = { ...viewRef.current, x: viewRef.current.x + (width - previous.width) / 2, y: viewRef.current.y + (height - previous.height) / 2 };
      }
      viewportRef.current = viewport;
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
      frameRef.current = null;
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
    if (busyRef.current || event.button !== 0 || !paperRef.current || (backgroundWantedRef.current && !backgroundRef.current)) return;
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
      setStrokeCount(strokesRef.current.length);
    }
    grab();
  };

  const undo = () => {
    if (busyRef.current || !strokesRef.current.length) return;
    resetPointers();
    strokesRef.current.pop();
    setStrokeCount(strokesRef.current.length);
    setError(null);
    redraw();
  };

  const done = async () => {
    if (busyRef.current) return;
    resetPointers();
    const image = backgroundRef.current ?? undefined;
    if (background && !image) {
      setError(backgroundState === "loading" ? "The background image is still loading." : `Could not load ${background.alt || "the background image"}.`);
      return;
    }
    if (!strokesRef.current.length && !image) { onClose(); return; }
    const paper = paperRef.current;
    if (!paper) { setError("The drawing paper is not available."); return; }
    const operation = ++operationRef.current;
    busyRef.current = true;
    setAttaching(true);
    setError(null);
    try {
      const result = await exportDrawing(paper, strokesRef.current, image);
      if (!mountedRef.current || operationRef.current !== operation) return;
      if (!result.ok) { setError(result.error); return; }
      let uploaded: DrawingAttachmentResult;
      try {
        uploaded = await onAttach(result.file);
      } catch (uploadError) {
        uploaded = { ok: false, error: messageFrom(uploadError, "Could not attach the drawing.") };
      }
      if (!mountedRef.current || operationRef.current !== operation) return;
      if (!uploaded.ok) setError(uploaded.error);
      else onClose();
    } finally {
      if (mountedRef.current && operationRef.current === operation) {
        busyRef.current = false;
        setAttaching(false);
      }
    }
  };

  return <section ref={sectionRef} className="drawing-canvas" aria-label={background ? `Image editor for ${background.alt || "image"}` : "Drawing editor"}>
    <div ref={surfaceRef} className="drawing-surface">
      <canvas ref={canvasRef} aria-label={background ? `${background.alt || "Image"}. Drag to draw. Use two fingers to move, zoom and rotate the image.` : "Drawing paper. Drag to draw. Use two fingers to move, zoom and rotate the paper."}
        onPointerDown={start} onPointerMove={move} onPointerUp={event => finish(event, false)}
        onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
        onPointerLeave={() => { cursorRef.current = null; redraw(); }} onContextMenu={event => event.preventDefault()} />
    </div>
    <div className="drawing-left-controls">
      <button type="button" className="drawing-done drawing-icon-button" aria-label="Cancel drawing" title="Cancel drawing" disabled={attaching} onClick={() => { operationRef.current += 1; resetPointers(); onClose(); }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
      <button type="button" className="drawing-done drawing-icon-button" aria-label="Undo last stroke" title="Undo last stroke" disabled={attaching || backgroundState !== "ready" || strokeCount === 0} onClick={undo}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4 4 9l5 5M4 9h10a6 6 0 0 1 0 12" /></svg>
      </button>
    </div>
    <div className="drawing-controls">
      <DrawingColourPicker color={color} onChange={setColor} disabled={attaching || backgroundState !== "ready"} />
      <button type="button" className="drawing-done" onClick={() => void done()} disabled={attaching || backgroundState !== "ready"}>{attaching ? "Saving…" : "Done"}</button>
    </div>
    {backgroundState === "loading" && <div className="drawing-status" role="status">Loading image…</div>}
    {error && <div className="drawing-error" role="alert"><span>{error}</span>{background && backgroundState === "failed" && <button type="button" onClick={() => setLoadAttempt(attempt => attempt + 1)}>Retry image</button>}</div>}
  </section>;
}
