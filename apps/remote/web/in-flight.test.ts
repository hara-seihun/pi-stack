import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ACTIVATION_WINDOW_MS, NATIVE_METHOD, attributedOrigin, beginRequest, inFlight, noteActivation, reportingBridge, requestVisibility } from "./src/in-flight";

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

test("writes always show; reads show only within the press window; the stream never shows", () => {
  expect(requestVisibility("POST", "/v1/sessions", null)).toBe("shown");
  expect(requestVisibility("DELETE", "/pi-stack/v1/sessions/x", 10_000)).toBe("shown");
  expect(requestVisibility("GET", "/v1/sessions", null)).toBe("background");
  expect(requestVisibility("GET", "/v1/sessions", ACTIVATION_WINDOW_MS)).toBe("shown");
  expect(requestVisibility("GET", "/v1/sessions", ACTIVATION_WINDOW_MS + 1)).toBe("background");
  expect(requestVisibility("POST", "/v1/stream", 5)).toBe("background");
  expect(requestVisibility("POST", "/v1/stream/abc", 5)).toBe("shown");
  expect(requestVisibility(NATIVE_METHOD, "native:getState", null)).toBe("background");
  expect(requestVisibility(NATIVE_METHOD, "native:installAppUpdate", 50)).toBe("shown");
  expect(requestVisibility(NATIVE_METHOD, "native:haptic", 50)).toBe("background");
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
  const server = beginRequest("GET", "/v1/sessions/thread/item", performance.now());
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
