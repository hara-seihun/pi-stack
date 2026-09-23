import { expect, test } from "bun:test";
import { drawingExportSize, fitPaper, grabPaper, paperPoint, screenPoint, screenRadius, zoomPaper, type PaperView } from "./src/drawing-paper";

const view: PaperView = { x: 300, y: 240, scale: 1.7, angle: 0.3 };

function samePoint(actual: { x: number; y: number }, expected: { x: number; y: number }) {
  expect(actual.x).toBeCloseTo(expected.x, 8);
  expect(actual.y).toBeCloseTo(expected.y, 8);
}

test("grabbing paper keeps both fingertips on their original paper points through scale, rotation and translation", () => {
  const from = [{ x: 100, y: 100 }, { x: 200, y: 100 }] as const;
  const to = [{ x: 340, y: 80 }, { x: 340, y: 280 }] as const;
  const first = paperPoint(from[0], view);
  const second = paperPoint(from[1], view);
  const next = grabPaper(view, from, to);
  samePoint(screenPoint(first, next), to[0]);
  samePoint(screenPoint(second, next), to[1]);
  expect(next.scale).toBeCloseTo(view.scale * 2);
  samePoint(paperPoint(screenPoint({ x: -42, y: 78 }, next), next), { x: -42, y: 78 });
});

test("wheel zoom holds the point beneath the cursor even at the zoom limits", () => {
  const cursor = { x: 170, y: 280 };
  const anchor = paperPoint(cursor, view);
  for (const factor of [0.0001, 0.5, 2, 10000]) {
    const next = zoomPaper(view, cursor, factor);
    samePoint(screenPoint(anchor, next), cursor);
    expect(next.angle).toBe(view.angle);
    expect(next.scale).toBeGreaterThanOrEqual(0.001);
    expect(next.scale).toBeLessThanOrEqual(64);
  }
});

test("an image is initially centered and contained at its original aspect ratio", () => {
  expect(fitPaper({ width: 4000, height: 2000 }, { width: 800, height: 600 })).toEqual({
    x: 400,
    y: 300,
    scale: 0.2,
    angle: 0,
  });
  expect(fitPaper({ width: 1000, height: 2000 }, { width: 800, height: 600 })).toEqual({
    x: 400,
    y: 300,
    scale: 0.3,
    angle: 0,
  });
  expect(fitPaper({ width: 32000, height: 18000 }, { width: 640, height: 480 }).scale).toBe(0.02);
});

test("background exports retain original pixels while white paper keeps high-resolution output", () => {
  const paper = { width: 4031, height: 3023 };
  expect(drawingExportSize(paper, true)).toEqual(paper);
  expect(drawingExportSize(paper, false)).toEqual({ width: 8062, height: 6046 });
});

test("a viewport-sized brush makes finer paper strokes when zoomed in", () => {
  const viewport = { width: 400, height: 800 };
  const radius = screenRadius(viewport);
  expect(radius).toBe(4);
  expect(screenRadius({ width: 800, height: 1600 })).toBe(radius * 2);
  const zoomed = zoomPaper(view, { x: 200, y: 400 }, 4);
  const paperRadiusBefore = radius / view.scale;
  const paperRadiusAfter = radius / zoomed.scale;
  expect(paperRadiusAfter).toBeCloseTo(paperRadiusBefore / 4);
  expect(paperRadiusAfter * zoomed.scale).toBeCloseTo(radius);
});
