import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Shell, TabNav } from "./src/app/Shell";
import { LONG_PRESS_MS, LongPressGesture } from "./src/app/long-press";
import { managerNavigation, monoTranscript, type ManagerPreference } from "./src/app/mono";
import { parseRoute, type Route } from "./src/app/routes";
import type { TranscriptItemHead } from "./src/types";
import { validateManagerView, validateStreamSnapshot, validateTranscriptHead } from "../shared/state-validation";

const classic: ManagerPreference = { view: "classic", managerThreadId: null, hintSeen: false };
const mono: ManagerPreference = { view: "mono", managerThreadId: "manager", hintSeen: false };
const root: Route = { tab: "chats", chat: null, panel: null };
const managerRoute: Route = { tab: "chats", chat: "ai:manager", panel: null };
const linkedRoute = parseRoute("#/chats/ai/original?question=q");

test("account preference selects mono on startup and cross-device changes, not during linked-thread navigation", () => {
  expect(managerNavigation(null, classic, root)).toBeNull();
  expect(managerNavigation(null, mono, root)).toEqual(managerRoute);
  expect(managerNavigation(null, mono, linkedRoute)).toBeNull();
  expect(managerNavigation(classic, mono, linkedRoute)).toEqual(managerRoute);
  expect(managerNavigation(mono, { ...mono, hintSeen: true }, linkedRoute)).toBeNull();
  expect(managerNavigation(mono, classic, managerRoute)).toEqual(root);
});

test("manager wire validation rejects unknown views, malformed hints and mono without a manager", () => {
  for (const valid of [classic, mono, { ...classic, managerThreadId: "manager", hintSeen: true }]) {
    expect(() => validateManagerView(valid)).not.toThrow();
    expect(() => validateStreamSnapshot("bootstrap", { type: "bootstrap", bootstrap: { environmentId: "local", managerOwnerEnvironmentId: "local", manager: valid } })).not.toThrow();
  }
  for (const invalid of [null, {}, { ...mono, view: "other" }, { ...mono, hintSeen: undefined }, { ...mono, hintSeen: "false" }, { ...mono, managerThreadId: null }, { ...mono, managerThreadId: " " }, { ...classic, managerThreadId: undefined }]) {
    expect(() => validateManagerView(invalid)).toThrow();
    expect(() => validateStreamSnapshot("bootstrap", { type: "bootstrap", bootstrap: { environmentId: "local", managerOwnerEnvironmentId: "local", manager: invalid } })).toThrow();
  }
  expect(() => validateStreamSnapshot("bootstrap", { type: "bootstrap", bootstrap: { environmentId: "work", managerOwnerEnvironmentId: "local", manager: null } })).not.toThrow();
  expect(() => validateStreamSnapshot("bootstrap", { type: "bootstrap", bootstrap: { environmentId: "local", managerOwnerEnvironmentId: "local", manager: null } })).toThrow();
  expect(() => validateTranscriptHead({ kind: "user", monoVisibility: "unknown" })).toThrow();
});

test("quiet native turns stay in history but render no mono entries, including wake input", () => {
  const heads: TranscriptItemHead[] = [
    { kind: "user", seq: 1, id: "human", size: 5, text: "Hello" },
    { kind: "user", seq: 2, id: "wake", size: 5, text: "Manager wake", monoVisibility: "hidden" },
    { kind: "thinking", seq: 3, id: "quiet-thinking", size: 5, preview: "Private work", monoVisibility: "hidden" },
    { kind: "toolCall", seq: 4, id: "quiet-tool", size: 5, callId: "tool", name: "read", arguments: {}, argumentsTruncated: false, monoVisibility: "hidden" },
    { kind: "assistant", seq: 5, id: "answer", size: 5, text: "Hello back", monoVisibility: "visible" },
  ];
  expect(monoTranscript(heads).map(head => head.id)).toEqual(["human", "answer"]);
  expect(monoTranscript(heads.slice(1, 4))).toEqual([]);
  expect(heads).toHaveLength(5);
  expect(heads[1]!.kind).toBe("user");
});

test("mono is one full-screen conversation without desktop rail, phone tabs or inbox", () => {
  for (const layout of ["phone", "desktop", "wide"] as const) {
    const html = renderToStaticMarkup(<Shell layout={layout} mono nav={<nav>Tabs</nav>} list={null} detail={<section>Manager conversation</section>} showDetail showTabs />);
    expect(html).toContain("single mono");
    expect(html).toContain("Manager conversation");
    expect(html).not.toContain("<nav");
    expect(html).not.toContain("pane-list");
    expect(html).not.toContain("hidden");
    const nav = renderToStaticMarkup(<TabNav layout={layout} active="chats" badges={{}} onSelect={() => {}} onMono={() => {}} />);
    expect(nav).toContain("Chats · Long-press for mono view");
  }
});

test("only a held press toggles; tap, movement and cancellation do not, and the held click is consumed once", async () => {
  let changes = 0;
  const gesture = new LongPressGesture(() => changes++);
  gesture.start(1, 10, 10);
  gesture.cancel();
  gesture.start(2, 10, 10);
  gesture.move(2, 30, 10);
  gesture.start(3, 10, 10);
  gesture.cancel();
  await Bun.sleep(LONG_PRESS_MS + 20);
  expect(changes).toBe(0);
  expect(gesture.takeClick()).toBe(false);
  gesture.start(4, 10, 10);
  await Bun.sleep(LONG_PRESS_MS + 20);
  gesture.cancel();
  expect(changes).toBe(1);
  expect(gesture.takeClick()).toBe(true);
  expect(gesture.takeClick()).toBe(false);
});
