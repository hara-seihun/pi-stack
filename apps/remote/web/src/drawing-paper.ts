export type Point = { x: number; y: number };
export type PaperView = { x: number; y: number; scale: number; angle: number };
export type PaperSize = { width: number; height: number };

export const BRUSH_VIEWPORT_FRACTION = 0.01;
const MIN_SCALE = 0.001;
const MAX_SCALE = 64;

function clampScale(scale: number) {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
}

export function fitPaper(paper: PaperSize, viewport: PaperSize): PaperView {
  return {
    x: viewport.width / 2,
    y: viewport.height / 2,
    scale: clampScale(Math.min(viewport.width / paper.width, viewport.height / paper.height)),
    angle: 0,
  };
}

export function drawingExportSize(paper: PaperSize, hasBackground: boolean): PaperSize {
  const resolution = hasBackground ? 1 : 2;
  return { width: Math.ceil(paper.width * resolution), height: Math.ceil(paper.height * resolution) };
}

export function screenRadius(viewport: PaperSize) {
  return Math.min(viewport.width, viewport.height) * BRUSH_VIEWPORT_FRACTION;
}

export function paperPoint(point: Point, view: PaperView): Point {
  const x = (point.x - view.x) / view.scale;
  const y = (point.y - view.y) / view.scale;
  const cosine = Math.cos(view.angle);
  const sine = Math.sin(view.angle);
  return { x: x * cosine + y * sine, y: y * cosine - x * sine };
}

export function screenPoint(point: Point, view: PaperView): Point {
  const cosine = Math.cos(view.angle);
  const sine = Math.sin(view.angle);
  return {
    x: view.x + view.scale * (point.x * cosine - point.y * sine),
    y: view.y + view.scale * (point.x * sine + point.y * cosine),
  };
}

function placeAnchor(view: PaperView, anchor: Point, target: Point): PaperView {
  const projected = screenPoint(anchor, view);
  return { ...view, x: view.x + target.x - projected.x, y: view.y + target.y - projected.y };
}

export function zoomPaper(view: PaperView, anchor: Point, factor: number): PaperView {
  const scale = clampScale(view.scale * factor);
  return placeAnchor({ ...view, scale }, paperPoint(anchor, view), anchor);
}

export function grabPaper(view: PaperView, from: readonly [Point, Point], to: readonly [Point, Point]): PaperView {
  const fromMiddle = { x: (from[0].x + from[1].x) / 2, y: (from[0].y + from[1].y) / 2 };
  const toMiddle = { x: (to[0].x + to[1].x) / 2, y: (to[0].y + to[1].y) / 2 };
  const startDistance = Math.hypot(from[1].x - from[0].x, from[1].y - from[0].y);
  const endDistance = Math.hypot(to[1].x - to[0].x, to[1].y - to[0].y);
  const rotation = Math.atan2(to[1].y - to[0].y, to[1].x - to[0].x)
    - Math.atan2(from[1].y - from[0].y, from[1].x - from[0].x);
  const scale = startDistance < 1 ? view.scale : clampScale(view.scale * endDistance / startDistance);
  return placeAnchor({ ...view, scale, angle: view.angle + rotation }, paperPoint(fromMiddle, view), toMiddle);
}
