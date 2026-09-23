import { afterEach, beforeEach, expect, test } from "bun:test";
import { systemBack } from "./src/app/system-back";

// A page with a hash, history, and whatever is open on top of the route.
class FakeElement extends EventTarget {
  constructor(readonly classes: string[]) { super(); }
  classList = { contains: (name: string) => this.classes.includes(name) };
}
type Page = { hash: string; dialog?: string[]; overlay?: "message-menu" | "chat-picker-popover" | "thread-color-palette" };
let page: Page;
let events: string[];
const saved: Record<string, unknown> = {};

function fakeDocument(): Document {
  const doc = new EventTarget() as EventTarget & { querySelector(selector: string): unknown };
  doc.querySelector = (selector: string) => {
    if (selector.startsWith("dialog")) return page.dialog ? new FakeElement(page.dialog) : null;
    return page.overlay && selector.includes(page.overlay) ? new FakeElement([page.overlay]) : null;
  };
  doc.addEventListener("keydown", event => events.push(`keydown:${(event as KeyboardEvent).key}`));
  return doc as unknown as Document;
}

// Bun has no KeyboardEvent; the handler only needs `key` on a plain Event.
class FakeKeyboardEvent extends Event { key: string; constructor(type: string, init: { key: string } & EventInit) { super(type, init); this.key = init.key; } }
(globalThis as Record<string, unknown>).KeyboardEvent ??= FakeKeyboardEvent;
(globalThis as Record<string, unknown>).HashChangeEvent ??= Event;

beforeEach(() => {
  events = [];
  page = { hash: "#/chats" };
  for (const name of ["location", "history", "window"]) saved[name] = (globalThis as Record<string, unknown>)[name];
  Object.assign(globalThis, {
    location: { get hash() { return page.hash; }, href: "https://router.test/" },
    history: { state: null, pushState: (_s: unknown, _t: string, hash: string) => { page.hash = hash; events.push(`push:${hash}`); }, replaceState: (_s: unknown, _t: string, hash: string) => { page.hash = hash; events.push(`replace:${hash}`); } },
    window: { dispatchEvent: () => true },
  });
});
afterEach(() => { for (const name of ["location", "history", "window"]) (globalThis as Record<string, unknown>)[name] = saved[name]; });

function press(document = fakeDocument()) {
  const actions = { closePanel: () => events.push("closePanel"), closeDetail: () => events.push("closeDetail") };
  return systemBack(actions, document);
}

test("back closes what is on top first: a dialog, then a menu or editor, then a panel, then the chat, then returns to Chats", () => {
  page = { hash: "#/chats/human/abc/inspector", dialog: ["sheet"] };
  expect(press()).toBe(true);
  expect(events).toEqual(["closePanel"]);

  events = []; page = { hash: "#/chats/human/abc", dialog: ["paste-text-dialog"] };
  const doc = fakeDocument();
  const dialog = doc.querySelector("dialog[open]") as unknown as EventTarget;
  const cancelled: string[] = [];
  // The fake returns a fresh element per query, so listen through the module's own lookup.
  (doc as unknown as { querySelector(selector: string): unknown }).querySelector = () => { dialog.addEventListener("cancel", () => cancelled.push("cancel")); return dialog; };
  expect(press(doc)).toBe(true);
  expect(cancelled).toEqual(["cancel"]);
  expect(events).toEqual([]);

  events = []; page = { hash: "#/chats/human/abc", overlay: "message-menu" };
  expect(press()).toBe(true);
  expect(events).toEqual(["keydown:Escape"]);

  events = []; page = { hash: "#/chats", overlay: "chat-picker-popover" };
  expect(press()).toBe(true);
  expect(events).toEqual(["keydown:Escape"]);

  events = []; page = { hash: "#/chats", overlay: "thread-color-palette" };
  expect(press()).toBe(true);
  expect(events).toEqual(["keydown:Escape"]);

  events = []; page = { hash: "#/chats/human/abc/queue" };
  expect(press()).toBe(true);
  expect(events).toEqual(["closePanel"]);

  events = []; page = { hash: "#/chats/human/abc" };
  expect(press()).toBe(true);
  expect(events).toEqual(["closeDetail"]);

  events = []; page = { hash: "#/workers/thread-1" };
  expect(press()).toBe(true);
  expect(events).toEqual(["closeDetail"]);

  events = []; page = { hash: "#/files/home/kenan" };
  expect(press()).toBe(true);
  expect(events).toEqual(["closeDetail"]);

  events = []; page = { hash: "#/machine" };
  expect(press()).toBe(true);
  expect(events).toEqual(["replace:#/chats"]);
});

test("back at the Chats home, or behind a dialog that refuses to cancel, leaves the app to the shell", () => {
  page = { hash: "#/chats" };
  expect(press()).toBe(false);
  page = { hash: "" };
  expect(press()).toBe(false);
  page = { hash: "#/chats/human/abc", dialog: ["unlock-dialog"] };
  expect(press()).toBe(false);
  page = { hash: "#/workers/t", dialog: ["sign-in-dialog"] };
  expect(press()).toBe(false);
  expect(events).toEqual([]);
});
