// The in-flight guarantee holds only if every API request goes through the
// one door that reports it. This test is that guarantee's proof: it reads the
// client source and fails when a request can leave by any other way.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "src");
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? files(path) : /\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
});
const source = new Map(files(root).map(path => [relative(root, path), readFileSync(path, "utf8")]));

/** The only ways a request may leave without passing the reporting door, each with the reason it is allowed. */
const RAW_TRANSPORT_ALLOWED: Record<string, string> = {
  "native.ts": "owns window.fetch: every API path passes through its override, which reports to in-flight.ts",
  "notification-control.tsx": "a timer-driven GET poll of other environments' notification feeds; no person pressed anything",
  "websocket.ts": "owns authorized WebSocket construction; long-lived sockets do not belong in the fetch in-flight counter",
};

test("every API request leaves through the fetch override that reports it", () => {
  const raw = /\b(browserFetch|XMLHttpRequest|sendBeacon|EventSource|new WebSocket)\b/;
  const offenders = [...source].filter(([file, text]) => raw.test(text) && !(file in RAW_TRANSPORT_ALLOWED)).map(([file]) => file);
  expect(offenders).toEqual([]);
  const native = source.get("native.ts")!;
  expect(native).toContain("window.fetch = async (input, init) => {");
  expect(native).toMatch(/const settle = beginRequest\([^)]*\);\s*try \{[\s\S]*?\} finally \{ settle\(\); \}/);
});

test("every page mounts the indicator and installs the door before anything can request", () => {
  for (const [page, native, indicator] of [["main.tsx", '"./native"', "App"], ["meet/page.tsx", '"../native"', "RequestIndicator"], ["voice-page.ts", '"./native"', "RequestIndicator"]] as const) {
    const text = source.get(page)!;
    expect(text).toMatch(new RegExp(`import (\\{[^}]*\\} from )?${native.replace(/[./]/g, "\\$&")}`));
    expect(text).toContain(indicator);
  }
  // The main app renders it at its root, above sign-in and unlock.
  expect(source.get("App.tsx")!).toContain("<><RequestIndicator /><SignInDialog /><UnlockDialog />");
  const inFlightSource = source.get("in-flight.ts")!;
  expect(inFlightSource).toContain('if (typeof document !== "undefined") installActivationTracking();');
});
