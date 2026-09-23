import { expect, test } from "bun:test";
import { formatProfile, measureLoopLag, profileMainThread, summarizeProfile, type ProfileInput } from "./profiler";

const frame = (name: string, sourceURL?: string, line = 1) => ({ name, sourceURL, line, category: sourceURL ? "Baseline" : "Unknown Executable" });

test("a profile folds samples into self time, inclusive time and whole stacks, ignoring idle samples", () => {
  const app = "/srv/pi/pi-remote/server/server.ts";
  const input: ProfileInput = { interval: 0.001, traces: [
    { timestamp: 1, frames: [frame("parse"), frame("projectState", app, 40), frame("refreshState", app, 50)] },
    { timestamp: 2, frames: [frame("parse"), frame("projectState", app, 40), frame("refreshState", app, 50)] },
    { timestamp: 3, frames: [frame("stringify"), frame("refreshState", app, 50)] },
    { timestamp: 4, frames: [frame("poll")] },
    { timestamp: 5, frames: [] },
  ] };
  const report = summarizeProfile(input, 1000);
  expect(report.samples).toBe(3);
  expect(report.busyPercent).toBe(0.3);
  expect(report.self[0]).toEqual({ where: "parse", samples: 2, percent: 66.7 });
  expect(report.inclusive[0]).toEqual({ where: "refreshState (server/server.ts:50)", samples: 3, percent: 100 });
  expect(report.inclusive.slice(1, 3).map(entry => entry.where).sort()).toEqual(["parse", "projectState (server/server.ts:40)"]);
  expect(report.stacks[0]).toEqual({ samples: 2, frames: ["refreshState (server/server.ts:50)", "projectState (server/server.ts:40)"] });
  const text = formatProfile(report);
  expect(text).toContain("main thread busy 0.3%");
  expect(text).toContain("66.7%       2  parse");
});

test("the live profiler sees a busy loop and a quiet one, and lag measures the stall", async () => {
  const spin = (ms: number) => { const until = performance.now() + ms; while (performance.now() < until) { /* burn */ } };
  const busy = profileMainThread(150, 500);
  const stall = setTimeout(() => spin(60), 20);
  const report = await busy;
  clearTimeout(stall);
  expect(report.busyPercent).toBeGreaterThan(20);
  expect(report.self.some(entry => entry.where.startsWith("spin ("))).toBe(true);
  const lag = measureLoopLag(120);
  setTimeout(() => spin(50), 30);
  const measured = await lag;
  expect(measured.maxMs).toBeGreaterThanOrEqual(40);
  expect(measured.p50Ms).toBeLessThan(40);
  const quiet = await profileMainThread(60, 500);
  expect(quiet.busyPercent).toBeLessThan(report.busyPercent);
});
