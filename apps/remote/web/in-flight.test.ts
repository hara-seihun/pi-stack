import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ACTIVATION_WINDOW_MS, NATIVE_METHOD, SLOW_REQUEST_MS, TIMING_HISTORY_LIMIT, attributedOrigin, beginRequest, beginSectionLoad, inFlight, noteActivation, reportingBridge, requestVisibility, setRequestTimingReporter, type RequestTiming } from "./src/in-flight";

class FakeControl {
  attributes = new Map<string, string>();
  constructor(readonly tag: string, readonly parent: FakeControl | null = null) {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  get busy() { return this.attributes.get("aria-busy") === "true"; }
  closest(selector: string): FakeControl | null {
    const wanted = selector.split(",").map(part => part.trim().split(/[\[:]/)[0]);
    let node: FakeControl | null = this;
    while (node) { if (wanted.includes(node.tag)) return node; node = node.parent; }
    return null;
  }
}

test("top-level requests and actions show; descendant media, read receipts and stream maintenance do not", () => {
  expect(requestVisibility("POST", "/v1/sessions", null)).toBe("shown");
  expect(requestVisibility("DELETE", "/pi-stack/v1/sessions/x", 10_000)).toBe("shown");
  expect(requestVisibility("GET", "/v1/sessions", null)).toBe("background");
  expect(requestVisibility("GET", "/v1/remotes/other/v1/sessions", ACTIVATION_WINDOW_MS)).toBe("shown");
  expect(requestVisibility("GET", "/v1/sessions", ACTIVATION_WINDOW_MS + 1)).toBe("background");
  for (const path of ["/v1/sessions/x/items/a", "/v1/sessions/x/images/hash", "/v1/sessions/x/transcript", "/v1/messaging/attachments/file", "/v1/messaging/backends/signal/avatars/person", "/v1/speech/utterances/id/audio", "/v1/files/download"]) {
    expect(requestVisibility("GET", path, 5)).toBe("background");
  }
  expect(requestVisibility("POST", "/v1/stream", 5)).toBe("background");
  expect(requestVisibility("POST", "/v1/stream/abc", 5)).toBe("background");
  expect(requestVisibility("POST", "/v1/remotes/other/v1/messaging/conversations/id/read", 5)).toBe("background");
  expect(requestVisibility("POST", "/v1/diagnostics/requests", 5)).toBe("background");
  expect(requestVisibility(NATIVE_METHOD, "native:getState", 5)).toBe("background");
  expect(requestVisibility(NATIVE_METHOD, "native:installAppUpdate", 50)).toBe("shown");
  expect(requestVisibility(NATIVE_METHOD, "native:haptic", 50)).toBe("background");
});

test("a section settles on its own readiness, independently of descendant fetches", () => {
  const events: number[] = [];
  const unsubscribe = inFlight.subscribe(() => events.push(inFlight.count()));
  const ready = beginSectionLoad("thread:one");
  const child = beginRequest("GET", "/v1/sessions/one/items/a");
  expect(inFlight.sections()).toEqual(["thread:one"]);
  expect(inFlight.count()).toBe(1);
  ready(); ready();
  expect(inFlight.count()).toBe(0);
  child();
  expect(events).toEqual([1, 0]);
  unsubscribe();
});

test("a native bridge call after a press shows like a request and settles with its promise", async () => {
  const button = new FakeControl("button");
  let resolve!: () => void;
  const bridge = reportingBridge({ enabled: true, installAppUpdate: () => new Promise<void>(done => { resolve = done; }), sync: () => 7 });
  noteActivation(button as unknown as EventTarget);
  const pending = bridge.installAppUpdate();
  expect(button.busy).toBe(false);
  expect(bridge.enabled).toBe(true);
  expect(bridge.sync()).toBe(7);
  expect(inFlight.count()).toBe(1);
  resolve(); await pending;
  expect(button.busy).toBe(false);
  expect(inFlight.count()).toBe(0);
});

test("a delayed tactile confirmation does not prolong the server progress bar", async () => {
  const button = new FakeControl("button");
  let resolve!: () => void;
  const bridge = reportingBridge({ haptic: () => new Promise<void>(done => { resolve = done; }) });
  noteActivation(button as unknown as EventTarget);
  const server = beginRequest("POST", "/v1/sessions/thread/prompt", performance.now());
  const haptic = bridge.haptic();
  expect(inFlight.count()).toBe(1);
  server();
  expect(inFlight.count()).toBe(0);
  resolve();
  await haptic;
  expect(inFlight.count()).toBe(0);
});

test("requests retain attribution without changing the pressed control", () => {
  const button = new FakeControl("button");
  const icon = new FakeControl("svg", button);
  const events: number[] = [];
  const unsubscribe = inFlight.subscribe(() => events.push(inFlight.count()));
  noteActivation(icon as unknown as EventTarget, 1_000);
  expect(inFlight.activation()?.element).toBe(button as unknown as Element);
  expect(attributedOrigin(inFlight.activation(), 1_000 + ACTIVATION_WINDOW_MS)).toBe(button as unknown as Element);
  expect(attributedOrigin(inFlight.activation(), 1_001 + ACTIVATION_WINDOW_MS)).toBeNull();

  const first = beginRequest("DELETE", "/v1/sessions/a", 1_050);
  const second = beginRequest("GET", "/v1/sessions", 1_060);
  expect(button.busy).toBe(false);
  expect(inFlight.count()).toBe(2);
  expect(inFlight.list().every(request => request.origin === (button as unknown as Element))).toBe(true);
  first(); first();
  expect(button.busy).toBe(false);
  expect(inFlight.count()).toBe(1);
  second();
  expect(button.busy).toBe(false);
  expect(inFlight.count()).toBe(0);
  expect(events).toEqual([1, 2, 1, 0]);
  unsubscribe();

  // A write with no press behind it still shows on the page, attributed to nothing.
  const late = beginRequest("POST", "/v1/messaging/conversations", 1_000 + ACTIVATION_WINDOW_MS + 500);
  expect(inFlight.count()).toBe(1);
  expect(inFlight.list()[0]?.origin).toBeNull();
  late();
  // A background read is a no-op: nothing to show, nothing to settle.
  const quiet = beginRequest("GET", "/v1/sessions", 1_000 + ACTIVATION_WINDOW_MS + 500);
  expect(inFlight.count()).toBe(0);
  quiet();
  expect(button.busy).toBe(false);
  noteActivation(null);
  noteActivation("not an element" as unknown as EventTarget);
});

test("slow nested requests retain latency diagnostics without owning global progress", () => {
  const reported: RequestTiming[] = [];
  setRequestTimingReporter(timing => reported.push(timing));
  try {
    const settle = beginRequest("GET", "/v1/messaging/conversations/chat/messages?private=value", performance.now() - SLOW_REQUEST_MS - 1);
    expect(inFlight.count()).toBe(0);
    settle();
    expect(reported.map(timing => timing.state)).toEqual(["pending", "settled"]);
    expect(reported.every(timing => timing.path === "/v1/messaging/conversations/chat/messages")).toBe(true);
    expect(inFlight.count()).toBe(0);
  } finally { setRequestTimingReporter(null); }
});

test("slow foreground requests report pending and settled without leaking query values", async () => {
  const reported: RequestTiming[] = [];
  setRequestTimingReporter(timing => reported.push(timing));
  try {
    const fast = beginRequest("POST", "/v1/sessions?message=secret");
    fast();
    const background = beginRequest("POST", "/v1/diagnostics/requests?secret=value");
    background();
    expect(reported).toEqual([]);

    const start = Date.now();
    const settle = beginRequest("post", "/v1/sessions/123?message=secret#private");
    await new Promise(resolve => setTimeout(resolve, SLOW_REQUEST_MS + 20));
    expect(inFlight.count()).toBe(1);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ method: "POST", path: "/v1/sessions/123", state: "pending" });
    expect(reported[0]!.startedAt).toBeGreaterThanOrEqual(start);
    expect(reported[0]!.durationMs).toBeGreaterThanOrEqual(SLOW_REQUEST_MS);
    settle(); settle();
    expect(reported).toHaveLength(2);
    expect(reported[1]).toMatchObject({ id: reported[0]!.id, state: "settled" });
    expect(reported[1]!.durationMs).toBeGreaterThanOrEqual(reported[0]!.durationMs);
    expect(inFlight.count()).toBe(0);
    expect(inFlight.timings().slice(-2)).toEqual(reported);
  } finally { setRequestTimingReporter(null); }
});

test("late timer callbacks and reporter failure do not alter request settlement; timing history is bounded", () => {
  setRequestTimingReporter(() => { throw new Error("diagnostic transport unavailable"); });
  try {
    for (let i = 0; i < TIMING_HISTORY_LIMIT; i++) {
      const settle = beginRequest("POST", `/v1/sessions/${i}`, performance.now() - SLOW_REQUEST_MS - 1);
      settle();
    }
    expect(inFlight.count()).toBe(0);
    expect(inFlight.timings()).toHaveLength(TIMING_HISTORY_LIMIT);
    expect(inFlight.timings().every(timing => !timing.path.includes("?"))).toBe(true);
    expect(inFlight.timings().at(-1)?.state).toBe("settled");
  } finally { setRequestTimingReporter(null); }
});

test("pointerdown prefetch leaves control attributes and styles to the component", () => {
  const button = new FakeControl("button");
  button.setAttribute("aria-busy", "true");
  button.setAttribute("aria-label", "Open conversation");
  const before = [...button.attributes];
  noteActivation(button as unknown as EventTarget, 1_000);
  const settle = beginRequest("GET", "/v1/sessions/chat/transcript", 1_001);
  expect([...button.attributes]).toEqual(before);
  settle();
  expect([...button.attributes]).toEqual(before);
  const css = readFileSync(new URL("./src/request-indicator.css", import.meta.url), "utf8");
  expect(css).not.toContain("[aria-busy");
  expect(css).not.toContain("color: transparent");
});
