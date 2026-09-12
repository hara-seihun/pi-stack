import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import "./drawing-canvas.css";

export type DrawingAttachmentResult = { ok: true } | { ok: false; error: string };

export interface DrawingCanvasProps {
  onAttach(file: File): Promise<DrawingAttachmentResult>;
  onClose(): void;
}

type Point = { x: number; y: number };
type Stroke = { color: string; radius: number; points: Point[] };
type CanvasSize = { width: number; height: number; dpr: number };
type Pinch = { distance: number; radius: number };
type AttachStatus = { kind: "success" | "error"; message: string } | null;

const MIN_RADIUS = 1;
const MAX_RADIUS = 64;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function hsvToHex(hue: number, saturation: number, value: number) {
  const chroma = value * saturation;
  const segment = hue / 60;
  const intermediate = chroma * (1 - Math.abs(segment % 2 - 1));
  const [red, green, blue] = segment < 1 ? [chroma, intermediate, 0]
    : segment < 2 ? [intermediate, chroma, 0]
    : segment < 3 ? [0, chroma, intermediate]
    : segment < 4 ? [0, intermediate, chroma]
    : segment < 5 ? [intermediate, 0, chroma]
    : [chroma, 0, intermediate];
  const offset = value - chroma;
  return `#${[red, green, blue].map(channel => Math.round((channel + offset) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function hexToHsv(hex: string) {
  const red = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const green = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const chroma = maximum - minimum;
  let hue = 0;
  if (chroma && maximum === red) hue = 60 * (((green - blue) / chroma + 6) % 6);
  else if (chroma && maximum === green) hue = 60 * ((blue - red) / chroma + 2);
  else if (chroma) hue = 60 * ((red - green) / chroma + 4);
  return { hue, saturation: maximum ? chroma / maximum : 0, value: maximum };
}

function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke, size: CanvasSize) {
  if (!stroke.points.length) return;
  context.save();
  context.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.lineWidth = stroke.radius * 2;
  context.lineCap = "round";
  context.lineJoin = "round";
  const first = stroke.points[0];
  if (stroke.points.length === 1) {
    context.beginPath();
    context.arc(first.x * size.width, first.y * size.height, stroke.radius, 0, Math.PI * 2);
    context.fill();
  } else {
    context.beginPath();
    context.moveTo(first.x * size.width, first.y * size.height);
    for (let index = 1; index < stroke.points.length; index += 1) {
      const point = stroke.points[index];
      context.lineTo(point.x * size.width, point.y * size.height);
    }
    context.stroke();
  }
  context.restore();
}

function drawScene(canvas: HTMLCanvasElement, size: CanvasSize, strokes: readonly Stroke[], active?: Stroke | null) {
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (const stroke of strokes) drawStroke(context, stroke, size);
  if (active) drawStroke(context, active, size);
}

function pngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("The browser could not create a PNG.")), "image/png");
  });
}

function drawingFilename() {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  return `pi-drawing-${timestamp}.png`;
}

function distance(first: Point, second: Point) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

export function DrawingCanvas({ onAttach, onClose }: DrawingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const wheelRef = useRef<HTMLDivElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const activeStrokeRef = useRef<Stroke | null>(null);
  const activePointerRef = useRef<number | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const pinchRef = useRef<Pinch | null>(null);
  const gestureRef = useRef(false);
  const sizeRef = useRef<CanvasSize>({ width: 1, height: 1, dpr: 1 });
  const radiusRef = useRef(8);
  const [, setHistoryRevision] = useState(0);
  const [radius, setRadius] = useState(8);
  const [hue, setHue] = useState(220);
  const [saturation, setSaturation] = useState(0.85);
  const [brightness, setBrightness] = useState(0.82);
  const [attaching, setAttaching] = useState(false);
  const [attachStatus, setAttachStatus] = useState<AttachStatus>(null);
  const color = hsvToHex(hue, saturation, brightness);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) drawScene(canvas, sizeRef.current, strokesRef.current, activeStrokeRef.current);
  }, []);

  const changeRadius = useCallback((next: number) => {
    const bounded = Math.round(clamp(next, MIN_RADIUS, MAX_RADIUS) * 2) / 2;
    radiusRef.current = bounded;
    setRadius(bounded);
  }, []);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const canvas = canvasRef.current;
    if (!surface || !canvas) return;
    const resize = () => {
      const bounds = surface.getBoundingClientRect();
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      sizeRef.current = { width, height, dpr };
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      drawScene(canvas, sizeRef.current, strokesRef.current, activeStrokeRef.current);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(surface);
    window.addEventListener("resize", resize);
    resize();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 80 : 1;
      const sensitivity = event.ctrlKey ? 0.08 : 0.025;
      changeRadius(radiusRef.current - event.deltaY * unit * sensitivity);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [changeRadius]);

  const canvasPoint = (clientX: number, clientY: number) => {
    const bounds = canvasRef.current!.getBoundingClientRect();
    return {
      x: clamp((clientX - bounds.left) / bounds.width, 0, 1),
      y: clamp((clientY - bounds.top) / bounds.height, 0, 1),
    };
  };

  const beginPinch = () => {
    const points = [...pointersRef.current.values()];
    if (points.length < 2) return;
    gestureRef.current = true;
    activeStrokeRef.current = null;
    activePointerRef.current = null;
    pinchRef.current = { distance: Math.max(1, distance(points[0], points[1])), radius: radiusRef.current };
    redraw();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType !== "touch" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size > 1) {
      beginPinch();
      return;
    }
    if (gestureRef.current) return;
    const stroke: Stroke = { color, radius: radiusRef.current, points: [canvasPoint(event.clientX, event.clientY)] };
    activeStrokeRef.current = stroke;
    activePointerRef.current = event.pointerId;
    redraw();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    event.preventDefault();
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gestureRef.current) {
      const points = [...pointersRef.current.values()];
      if (points.length >= 2 && pinchRef.current) {
        const scale = distance(points[0], points[1]) / pinchRef.current.distance;
        changeRadius(pinchRef.current.radius * scale);
      }
      return;
    }
    const stroke = activeStrokeRef.current;
    if (!stroke || activePointerRef.current !== event.pointerId) return;
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const sample of samples.length ? samples : [event.nativeEvent]) {
      const point = canvasPoint(sample.clientX, sample.clientY);
      const previous = stroke.points.at(-1)!;
      const size = sizeRef.current;
      if (Math.hypot((point.x - previous.x) * size.width, (point.y - previous.y) * size.height) >= 0.35) stroke.points.push(point);
    }
    redraw();
  };

  const finishPointer = (event: ReactPointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.delete(event.pointerId);
    if (gestureRef.current) {
      if (!pointersRef.current.size) {
        gestureRef.current = false;
        pinchRef.current = null;
      }
      return;
    }
    if (activePointerRef.current !== event.pointerId) return;
    const stroke = activeStrokeRef.current;
    activeStrokeRef.current = null;
    activePointerRef.current = null;
    if (!cancelled && stroke) {
      const end = canvasPoint(event.clientX, event.clientY);
      const previous = stroke.points.at(-1)!;
      if (end.x !== previous.x || end.y !== previous.y) stroke.points.push(end);
      strokesRef.current.push(stroke);
      setHistoryRevision(revision => revision + 1);
      redraw();
    } else {
      redraw();
    }
  };

  const undo = () => {
    if (!strokesRef.current.length) return;
    strokesRef.current.pop();
    setHistoryRevision(revision => revision + 1);
    redraw();
  };

  const clear = () => {
    if (!strokesRef.current.length) return;
    strokesRef.current = [];
    setHistoryRevision(revision => revision + 1);
    redraw();
  };

  const chooseWheelColor = (clientX: number, clientY: number) => {
    const bounds = wheelRef.current!.getBoundingClientRect();
    const x = clientX - bounds.left - bounds.width / 2;
    const y = clientY - bounds.top - bounds.height / 2;
    const nextSaturation = clamp(Math.hypot(x, y) / (Math.min(bounds.width, bounds.height) / 2), 0, 1);
    const nextHue = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    setHue(nextHue);
    setSaturation(nextSaturation);
  };

  const onWheelPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    chooseWheelColor(event.clientX, event.clientY);
  };

  const onWheelKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const hueChange = event.key === "ArrowLeft" ? -3 : event.key === "ArrowRight" ? 3 : 0;
    const saturationChange = event.key === "ArrowDown" ? -0.04 : event.key === "ArrowUp" ? 0.04 : 0;
    if (!hueChange && !saturationChange) return;
    event.preventDefault();
    if (event.shiftKey || saturationChange) setSaturation(current => clamp(current + (saturationChange || hueChange / 75), 0, 1));
    else setHue(current => (current + hueChange + 360) % 360);
  };

  const attach = async () => {
    if (attaching) return;
    setAttaching(true);
    setAttachStatus(null);
    try {
      const size = sizeRef.current;
      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = Math.max(1, Math.round(size.width * size.dpr));
      exportCanvas.height = Math.max(1, Math.round(size.height * size.dpr));
      drawScene(exportCanvas, size, strokesRef.current);
      const blob = await pngBlob(exportCanvas);
      const result = await onAttach(new File([blob], drawingFilename(), { type: "image/png", lastModified: Date.now() }));
      if (!result.ok) {
        setAttachStatus({ kind: "error", message: `Could not attach drawing: ${result.error}` });
        return;
      }
      setAttachStatus({ kind: "success", message: "Drawing attached. It has not been sent." });
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAttachStatus({ kind: "error", message: `Could not attach drawing: ${message}` });
    } finally {
      setAttaching(false);
    }
  };

  const wheelStyle = {
    "--wheel-darkness": String(1 - brightness),
    "--wheel-x": `${50 + Math.cos(hue * Math.PI / 180) * saturation * 46}%`,
    "--wheel-y": `${50 + Math.sin(hue * Math.PI / 180) * saturation * 46}%`,
  } as CSSProperties;
  const radiusLabel = Number.isInteger(radius) ? String(radius) : radius.toFixed(1);
  const hasStrokes = strokesRef.current.length > 0;

  return <section className="drawing-canvas" aria-label="Drawing editor">
    <header className="drawing-toolbar">
      <button className="drawing-button drawing-back" type="button" onClick={onClose}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        <span>Back to chat</span>
      </button>
      <div className="drawing-color-control" aria-label="Brush colour controls">
        <div
          ref={wheelRef}
          className="drawing-color-wheel"
          role="slider"
          tabIndex={0}
          aria-label="Brush colour hue"
          aria-valuemin={0}
          aria-valuemax={359}
          aria-valuenow={Math.round(hue) % 360}
          aria-valuetext={`${color}, ${Math.round(saturation * 100)}% saturation`}
          title="Choose brush colour. Arrow keys change hue and saturation."
          style={wheelStyle}
          onPointerDown={onWheelPointer}
          onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) chooseWheelColor(event.clientX, event.clientY); }}
          onKeyDown={onWheelKey}
        ><span className="drawing-wheel-marker" /></div>
        <div className="drawing-color-details">
          <label className="drawing-swatch" title="Open the system colour picker">
            <span style={{ background: color }} />
            <input type="color" aria-label="Brush colour" value={color} onChange={event => { const next = hexToHsv(event.target.value); setHue(next.hue); setSaturation(next.saturation); setBrightness(next.value); }} />
          </label>
          <label className="drawing-brightness">
            <span>Brightness</span>
            <input type="range" min={0} max={1} step={0.01} value={brightness} onChange={event => setBrightness(Number(event.target.value))} />
          </label>
        </div>
      </div>
      <label className="drawing-radius-control">
        <span className="drawing-radius-preview" aria-hidden="true"><i style={{ width: Math.min(48, radius * 2), height: Math.min(48, radius * 2), background: color }} /></span>
        <span className="drawing-radius-copy"><strong>Brush radius</strong><output>{radiusLabel} px</output></span>
        <input type="range" min={MIN_RADIUS} max={MAX_RADIUS} step={0.5} value={radius} aria-label="Brush radius in pixels" onChange={event => changeRadius(Number(event.target.value))} />
      </label>
      <div className="drawing-toolbar-spacer" />
      <div className="drawing-history-actions">
        <button className="drawing-button" type="button" disabled={!hasStrokes} onClick={undo}>Undo</button>
        <button className="drawing-button" type="button" disabled={!hasStrokes} onClick={clear}>Clear</button>
      </div>
      <button className="drawing-button drawing-attach" type="button" disabled={attaching} onClick={() => void attach()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 6.5 8.7 14.3a2.5 2.5 0 0 0 3.5 3.5l8.1-8.1a4.5 4.5 0 0 0-6.4-6.4L5.5 11.7a6.5 6.5 0 0 0 9.2 9.2l6.1-6.1" /></svg>
        <span>{attaching ? "Attaching…" : "Attach drawing as PNG"}</span>
      </button>
      {attachStatus && <p className={`drawing-attach-status ${attachStatus.kind}`} role={attachStatus.kind === "error" ? "alert" : "status"}>{attachStatus.message}</p>}
    </header>
    <div ref={surfaceRef} className="drawing-surface">
      <canvas
        ref={canvasRef}
        aria-label="Drawing area. Drag to draw. Scroll or pinch with two fingers to change brush radius."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={event => finishPointer(event, false)}
        onPointerCancel={event => finishPointer(event, true)}
        onLostPointerCapture={event => finishPointer(event, true)}
        onContextMenu={event => event.preventDefault()}
      />
      <div className="drawing-surface-hint" aria-hidden="true">Drag to draw · scroll or pinch to resize brush</div>
    </div>
  </section>;
}

