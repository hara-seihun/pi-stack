import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runningChildParents, threadActivity } from "../server/live-projection";
import { sessionDelta } from "../server/stream";
import { InboxRowView } from "./src/features/chats/Inbox";
import type { Session } from "../server/protocol";
import type { MessagingSnapshot } from "../server/messaging/protocol";
import { applySessionDelta, currentChats, inboxRows, reconcileDiscoveredSessions, selectedAiId, selectionAfterSync } from "./src/chats";
import { threadStatus } from "./src/features/status/thread-status";

// Artwork paths derive from the page address; there is no page here.
globalThis.location ??= new URL("https://router.test/") as unknown as Location;

const session = (id: string, patch: Partial<Session> = {}): Session => ({
  id, parentId: null, hasChildren: false, origin: "person", model: "model", name: id,
  cwd: "/", workspaceName: "", environment: "local", state: "idle", held: false, activity: "idle", activeTools: [],
  provider: "openai", createdAt: "", updatedAt: "2026-01-01T00:00:00Z", revision: 1, idleUnread: false,
  queuedMessages: [], archivedAt: null, ...patch,
});
const queued: Session["queuedMessages"][number] = { id: "q", text: "later", delivery: "queue", state: "queued", canSteer: false, canHardSteer: false, canCancel: true, createdAt: "" };
const messaging: MessagingSnapshot = {
  version: 1,
  backends: [{ id: "signal-personal", plugin: "signal", label: "Signal", icon: "signal", status: "ready", detail: "", capabilities: { attachments: true, groups: true } }],
  conversations: [
    { id: "same-id", backendId: "signal-personal", externalId: "+123", title: "A person", kind: "direct", updatedAt: 5, unread: 0, current: true, avatar: null },
    { id: "unread", backendId: "signal-personal", externalId: "+789", title: "Waiting", kind: "direct", updatedAt: 2, unread: 3, current: true, avatar: 1700 },
    { id: "directory-only", backendId: "signal-personal", externalId: "+456", title: "Not open", kind: "direct", updatedAt: 1, unread: 0, current: false, avatar: null },
  ],
};

test("inbox ranks attention, then work, then quiet, mixing AI and human chats", () => {
  const ai = session("same-id");
  const rows = inboxRows([
    ai,
    session("child", { parentId: ai.id, state: "running" }),
    session("held", { held: true, queuedMessages: [queued] }),
    session("unread", { idleUnread: true }),
    session("busy", { state: "running", activity: "waiting_on_tool", activeTools: ["bash"] }),
    session("parent", { activity: "awaiting", hasChildren: true }),
    session("old", { updatedAt: "2025-01-01T00:00:00Z" }),
  ], [], messaging);
  expect(rows.map(row => row.chat.id)).toEqual(["ai:held", "ai:unread", "human:unread", "ai:busy", "ai:parent", "ai:same-id", "ai:old", "human:same-id"]);
  expect(rows.map(row => row.section)).toEqual(["attention", "attention", "attention", "working", "working", "quiet", "quiet", "quiet"]);
  expect(rows[0].chat).toMatchObject({ kind: "ai", session: { id: "held" } });
  expect(rows[2].chat).toMatchObject({ kind: "human", icon: "signal" });
  expect(currentChats([ai], [], messaging).map(item => item.id)).toEqual(["human:unread", "ai:same-id", "human:same-id"]);
});

test("a Signal chat with a picture shows it in the inbox; one without keeps the service glyph", () => {
  const previous = globalThis.window;
  globalThis.window = { PiRemotePerson: { href: (path: string) => `${path}&session=s` }, KenanRemote: { resolveApiUrl: (path: string) => path } } as unknown as Window & typeof globalThis;
  try {
    const rows = inboxRows([], [], messaging);
    const withPicture = rows.find(row => row.chat.id === "human:unread")!;
    const without = rows.find(row => row.chat.id === "human:same-id")!;
    expect(withPicture.chat).toMatchObject({ kind: "human", avatar: "/v1/messaging/backends/signal-personal/avatars/%2B789?v=1700&session=s" });
    expect(without.chat).not.toHaveProperty("avatar");
    const render = (row: typeof withPicture) => renderToStaticMarkup(createElement(InboxRowView, { row, selected: false, compactSelected: false, place: "", onOpen() {}, onClose() {} }));
    expect(render(withPicture)).toContain('class="chat-avatar" src="/v1/messaging/backends/signal-personal/avatars/%2B789?v=1700&amp;session=s"');
    expect(render(without)).toContain('class="thread-provider"');
    expect(render(without)).not.toContain("chat-avatar");
  } finally { globalThis.window = previous; }
});

test("the last worker settling clears waiting status through projection, stream and inbox", () => {
  const parent = session("parent", { hasChildren: true });
  const local = session("local", { parentId: parent.id });
  const fleet = session("fleet", { parentId: parent.id, state: "running" });
  const project = () => ({ ...parent, activity: threadActivity(parent.state, undefined, runningChildParents([local], [fleet]).has(parent.id)) });
  const waiting = project();
  expect(threadStatus(waiting)).toMatchObject({ key: "awaiting", busy: true });

  fleet.state = "idle";
  const settled = project();
  const delta = sessionDelta(new Map([[parent.id, JSON.stringify(waiting)]]), [{ session: settled, encoded: JSON.stringify(settled) }]);
  const [received] = applySessionDelta([waiting], { reset: false, ...delta });
  expect(received.revision).toBe(waiting.revision);
  expect(threadStatus(received)).toMatchObject({ key: "idle", busy: false });
  const row = inboxRows([received], [], { ...messaging, conversations: [] })[0];
  expect(row.section).toBe("quiet");
  const markup = renderToStaticMarkup(createElement(InboxRowView, {
    row: { ...row, chat: { ...row.chat, icon: "🤖" } }, selected: false, compactSelected: false, place: "", onOpen() {}, onClose() {},
  }));
  expect(markup).not.toContain('class="inbox-chip"');

  parent.state = "running";
  expect(threadStatus(project())).toMatchObject({ key: "running", busy: true });
});

test("status vocabulary covers every lifecycle and flag", () => {
  expect(threadStatus(session("a")).key).toBe("idle");
  expect(threadStatus(session("a", { state: "running" }))).toMatchObject({ key: "running", label: "Working", busy: true });
  expect(threadStatus(session("a", { state: "running", activity: "thinking" })).key).toBe("thinking");
  expect(threadStatus(session("a", { state: "running", activity: "waiting_on_tool", activeTools: ["functions.agent_browser"] })).label).toBe("Running agent browser");
  expect(threadStatus(session("a", { state: "running", activity: "waiting_on_tool", activeTools: ["bash", "web_search"] }))).toMatchObject({ label: "Running bash and web search", short: "2 tools" });
  expect(threadStatus(session("a", { state: "running", activity: "waiting_on_tool", activeTools: ["bash", "functions.web_search", "agent_browser"] }))).toMatchObject({ label: "Running 3 tools", short: "3 tools", title: "bash, web search, agent browser" });
  expect(threadStatus(session("a", { held: true, queuedMessages: [queued] }))).toMatchObject({ key: "stopped", label: "Stopped", attention: true });
  expect(threadStatus(session("a", { idleUnread: true }))).toMatchObject({ key: "idle", label: "Idle", attention: true });
  expect(threadStatus(session("a", { archivedAt: "2026" })).key).toBe("archived");
  expect(threadStatus(session("a", { activity: "awaiting" }))).toMatchObject({ key: "awaiting", busy: true });
  expect(selectedAiId({ selectedChatId: "human:same-id" })).toBeNull();
  expect(selectedAiId({ selectedChatId: "ai:same-id" })).toBe("same-id");
});

test("the inbox keeps idle unread as Idle with a dot and gives multi-tool names as title detail", () => {
  const unread = inboxRows([session("unread", { idleUnread: true })], [], { ...messaging, conversations: [] })[0]!;
  const unreadMarkup = renderToStaticMarkup(createElement(InboxRowView, {
    row: { ...unread, chat: { ...unread.chat, icon: "🤖" } }, selected: false, compactSelected: false, place: "", onOpen() {}, onClose() {},
  }));
  expect(unreadMarkup).toContain('data-status="idle"');
  expect(unreadMarkup).toContain('class="inbox-unread-dot"');
  expect(unreadMarkup).not.toContain("Done");

  const tools = inboxRows([session("tools", { state: "running", activity: "waiting_on_tool", activeTools: ["bash", "functions.web_search", "agent_browser"] })], [], { ...messaging, conversations: [] })[0]!;
  const toolsMarkup = renderToStaticMarkup(createElement(InboxRowView, {
    row: { ...tools, chat: { ...tools.chat, icon: "🤖" } }, selected: false, compactSelected: false, place: "", onOpen() {}, onClose() {},
  }));
  expect(toolsMarkup).toContain('title="bash, web search, agent browser"');
  expect(toolsMarkup).toContain("3 tools");

  // A working thread says so. Leaving its word to the section header showed "· Fable": a blank where the state goes.
  const working = inboxRows([session("busy", { state: "running", activity: "running" })], [], { ...messaging, conversations: [] })[0]!;
  const workingMarkup = renderToStaticMarkup(createElement(InboxRowView, {
    row: { ...working, chat: { ...working.chat, icon: "🤖" } }, selected: false, compactSelected: false, place: "", onOpen() {}, onClose() {},
  }));
  expect(workingMarkup).toContain('data-status="running"');
  expect(workingMarkup).toContain('class="status-label">Working</span>');
  expect(workingMarkup).toMatch(/<span class="inbox-status-line"><span class="status-pill/);
});

test("session deltas upsert by id, remove by id and reset the whole list", () => {
  const held = [session("a"), session("b"), session("c")];
  const changed = applySessionDelta(held, { reset: false, sessions: [session("b", { state: "running" }), session("d")], removed: ["a"] });
  expect(changed.map(item => item.id)).toEqual(["b", "c", "d"]);
  expect(changed[0].state).toBe("running");
  expect(changed[1]).toBe(held[2]);

  expect(applySessionDelta(changed, { reset: true, sessions: [session("only")], removed: [] }).map(item => item.id)).toEqual(["only"]);
  expect(applySessionDelta(held, { reset: false, sessions: [], removed: [] })).toEqual(held);
  // A row that arrives and is removed in the same delta does not come back.
  expect(applySessionDelta(held, { reset: false, sessions: [session("e")], removed: ["e"] }).map(item => item.id)).toEqual(["a", "b", "c"]);
});

test("an authoritative reset discards directly discovered rows that disappeared while disconnected", () => {
  const discovered = [session("running-worker", { parentId: "root", state: "running" })];
  expect(reconcileDiscoveredSessions(discovered, [session("root")], { reset: true, removed: [] })).toEqual([]);

  expect(reconcileDiscoveredSessions(discovered, [], { reset: false, removed: [] })).toEqual(discovered);
  expect(reconcileDiscoveredSessions(discovered, [session("running-worker", { state: "idle" })], { reset: false, removed: [] })).toEqual([]);
  expect(reconcileDiscoveredSessions(discovered, [], { reset: false, removed: ["running-worker"] })).toEqual([]);
});

test("patches change named fields of held rows and retain untouched values", () => {
  const held = [session("a", { held: true }), session("b")];
  const patched = applySessionDelta(held, {
    reset: false, sessions: [],
    patches: [{ id: "a", activity: "waiting_on_tool", activeTools: ["bash"], state: "running", held: false, revision: 2 }],
    removed: [],
  });
  expect(patched[0]).toMatchObject({ id: "a", state: "running", held: false, activity: "waiting_on_tool", activeTools: ["bash"], revision: 2 });
  // Untouched fields keep their held values, and other rows are untouched.
  expect(patched[0].name).toBe("a");
  expect(patched[0].model).toBe("model");
  expect(patched[1]).toBe(held[1]);

  // A patch for a row this client does not hold is not half a row.
  expect(applySessionDelta(held, { reset: false, sessions: [], patches: [{ id: "unknown", state: "running" }], removed: [] }).map(item => item.id)).toEqual(["a", "b"]);
  // A removal wins over a patch in the same delta.
  expect(applySessionDelta(held, { reset: false, sessions: [], patches: [{ id: "a", state: "running" }], removed: ["a"] }).map(item => item.id)).toEqual(["b"]);
  // A full row for a held id still replaces it wholesale.
  expect(applySessionDelta(held, { reset: false, sessions: [session("a", { name: "renamed" })], patches: [{ id: "a", name: "patched" }], removed: [] })[0].name).toBe("renamed");
});

test("sync clears chats closed on another device but incoming reopen never takes focus", () => {
  const before = { sessions: [session("a")], messaging };
  const closed = { sessions: [], messaging: { ...messaging, conversations: messaging.conversations.map(item => ({ ...item, current: false })) } };
  expect(selectionAfterSync("ai:a", before, closed)).toBeNull();
  expect(selectionAfterSync("human:same-id", before, closed)).toBeNull();
  expect(selectionAfterSync(null, closed, before)).toBeNull();
  expect(selectionAfterSync("ai:a", { ...closed, sessions: before.sessions }, before)).toBe("ai:a");
  expect(selectionAfterSync("ai:just-created", closed, before)).toBe("ai:just-created");
});
