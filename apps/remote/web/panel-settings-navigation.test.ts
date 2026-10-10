import { afterEach, beforeEach, expect, test } from "bun:test";
import { back, currentRoute, navigate, replacePanel } from "./src/app/routes";

const saved = new Map<string, PropertyDescriptor | undefined>();
let entries: string[];
let index: number;
let traversals: (() => void)[];

beforeEach(() => {
  entries = ["#/chats"];
  index = 0;
  traversals = [];
  const globals = {
    location: { get hash() { return entries[index]; }, get href() { return `https://remote.test/${entries[index]}`; } },
    history: {
      state: null,
      pushState(_state: unknown, _title: string, hash: string) { entries.splice(++index, Infinity, hash); },
      replaceState(_state: unknown, _title: string, hash: string) { entries[index] = hash; },
      back() { const target = index - 1; traversals.push(() => { if (target >= 0) index = target; }); },
    },
    window: new EventTarget(),
    HashChangeEvent: Event,
  };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});
afterEach(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

const settleTraversal = () => { for (const move of traversals.splice(0)) move(); };
const thread = { tab: "chats", chat: "ai:thread", panel: null } as const;

for (const pushed of [true, false]) {
  test(`${pushed ? "push" : "replace"}-opened inspector is consumed by Settings without a pending Back`, () => {
    navigate(thread);
    navigate({ ...thread, panel: "inspector" }, { replace: !pushed });
    const panelPushed = { current: pushed };
    const length = entries.length;
    replacePanel({ tab: "settings" }, panelPushed);
    expect(panelPushed.current).toBe(false);
    expect(traversals).toHaveLength(0);
    settleTraversal();
    expect(currentRoute()).toEqual({ tab: "settings" });
    expect(entries).toHaveLength(length);
    back();
    settleTraversal();
    expect(currentRoute()).toEqual(pushed ? thread : { tab: "chats", chat: null, panel: null });
    expect(entries.some(hash => hash.endsWith("/inspector"))).toBe(false);
  });
}

test("direct Settings navigation still pushes and Back returns to the thread", () => {
  navigate(thread);
  navigate({ tab: "settings" });
  expect(currentRoute()).toEqual({ tab: "settings" });
  expect(entries).toHaveLength(3);
  back();
  settleTraversal();
  expect(currentRoute()).toEqual(thread);
});

test("deep-linked inspector can open Settings without traversing outside the app", () => {
  entries = ["#/chats/ai/thread/inspector"];
  replacePanel({ tab: "settings" }, { current: false });
  expect(entries).toEqual(["#/settings"]);
  expect(traversals).toHaveLength(0);
});
