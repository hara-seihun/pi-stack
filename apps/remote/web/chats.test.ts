import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatIcon } from "./src/chat-row";
import { InboxRowView } from "./src/features/chats/Inbox";
import type { Session } from "../server/protocol";
import { currentChats, inboxRows, reconcileDiscoveredSessions, selectedAiId, selectionAfterSync } from "./src/chats";
import { threadStatus } from "./src/features/status/thread-status";

// Artwork paths derive from the page address; there is no page here.
globalThis.location ??= new URL("https://router.test/") as unknown as Location;

const session = (id: string, patch: Partial<Session> = {}): Session => ({
  id, parentId: null, hasChildren: false, origin: "person", model: "model", name: id,
  cwd: "/", workspaceName: "", environment: "local", state: "idle", lifecycle: { kind: "idle" }, held: false, activity: "idle", activeTools: [],
  provider: "openai", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", lastUserMessageAt: "2026-01-01T00:00:00Z", revision: 1, idleUnread: false, humanAttention: true,
  queuedMessages: [], archivedAt: null, ...patch,
});
const queued: Session["queuedMessages"][number] = { id: "q", text: "later", delivery: "queue", state: "queued", canSteer: false, canHardSteer: false, canCancel: true, createdAt: "" };
test("inbox ranks attention, then work, then quiet",  () => {
  const ai = session("same-id");
  const rows = inboxRows([
    ai,
    session("child", { parentId: ai.id, state: "running", lifecycle: { kind: "working", phase: "thinking", since: 1 } }),
    session("held", { held: true, queuedMessages: [queued] }),
    session("unread", { idleUnread: true }),
    session("busy", { state: "running", lifecycle: { kind: "working", phase: "waiting_on_tool", since: 1 }, activity: "waiting_on_tool", activeTools: ["bash"] }),
    session("parent", { lifecycle: { kind: "waiting", target: "agents", reason: "Need result", since: 1 }, activity: "awaiting", hasChildren: true, waitingOnAgents: { kind: "agents", threadIds: ["child"], reason: "Need result", since: 1 } }),
    session("old", { updatedAt: "2025-01-01T00:00:00Z", lastUserMessageAt: "2025-01-01T00:00:00Z" }),
  ], []);
  expect(rows.map(row => row.chat.id)).toEqual(["ai:unread", "ai:busy", "ai:parent", "ai:held", "ai:same-id", "ai:old"]);
  expect(rows.map(row => row.section)).toEqual(["attention", "working", "quiet", "quiet", "quiet", "quiet"]);
  expect(rows[0].chat).toMatchObject({ kind: "ai", session: { id: "unread" } });
  expect(currentChats([ai], []).map(item => item.id)).toEqual(["ai:same-id"]);
});

test("user-message recency, not agent activity or edits, orders threads within each rank", () => {
  const older = session("older", { lastUserMessageAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-09T00:00:00Z" });
  const newer = session("newer", { lastUserMessageAt: "2026-01-03T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z" });
  const empty = session("empty", { lastUserMessageAt: undefined, createdAt: "2026-01-04T00:00:00Z" });
  const order = () => inboxRows([older, newer, empty], []).map(row => row.chat.id);
  expect(order()).toEqual(["ai:empty", "ai:newer", "ai:older"]);
  older.updatedAt = "2026-01-10T00:00:00Z";
  expect(order()).toEqual(["ai:empty", "ai:newer", "ai:older"]);
  older.lastUserMessageAt = "2026-01-11T00:00:00Z";
  expect(order()).toEqual(["ai:older", "ai:empty", "ai:newer"]);
});

test("rooms share inbox ranking and row controls, and closing excludes only that room", () => {
  const rooms = [
    { id: "shared", title: "Shared", members: [{ user: "kenan", displayName: "Hara" }], lifecycle: { kind: "idle" as const }, current: true, updatedAt: 10, unreadCount: 2 },
    { id: "working", title: "Working room", members: [], state: "running" as const, lifecycle: { kind: "working" as const, phase: "thinking" as const, since: 20 }, activity: "thinking" as const, updatedAt: 20 },
    { id: "closed", title: "Closed room", members: [], current: false, unreadCount: 5 },
    { id: "question", title: "Question", members: [], lifecycle: { kind: "idle" as const }, pendingQuestions: 1, updatedAt: 30 },
  ];
  const rows = inboxRows([session("busy", { state: "running", lifecycle: { kind: "working", phase: "thinking", since: 15 }, updatedAt: new Date(15).toISOString(), lastUserMessageAt: new Date(15).toISOString() })], [], rooms);
  expect(rows.map(row => row.chat.id)).toEqual(["room:question", "room:shared", "room:working", "ai:busy"]);
  expect(rows.map(row => row.section)).toEqual(["attention", "attention", "working", "working"]);
  const room = rows.find(row => row.chat.id === "room:shared")!;
  const markup = renderToStaticMarkup(createElement(InboxRowView, { row: room, selected: true, compactSelected: false, place: "", onOpen() {}, onClose() {} }));
  expect(markup).toContain('aria-current="true"');
  expect(markup).toContain('class="inbox-close"');
  expect(markup).toContain("2 unread");
  expect(markup).toContain("Hara");
});

test("destination pictures retain their artwork when a thread has a colour", () => {
  for (const icon of ["raw", "sandbox", "room"]) {
    const markup = renderToStaticMarkup(createElement(ChatIcon, { icon, color: "#ff00ff" }));
    expect(markup).toContain(`${icon}.svg`);
    expect(markup).not.toContain("feFlood");
  }
  expect(renderToStaticMarkup(createElement(ChatIcon, { icon: "openai", color: "#ff00ff" }))).toContain("feFlood");
});

test("running and dependency-waiting launched agents do not make an idle launcher busy", () => {
  const parent = session("parent", { hasChildren: true, activity: "idle" });
  const local = session("local", { parentId: parent.id, state: "running", lifecycle: { kind: "working", phase: "thinking", since: 1 }, activity: "thinking" });
  const fleet = session("fleet", { parentId: parent.id, origin: "fleet", lifecycle: { kind: "waiting", target: "message", reason: "Rental cleanup", since: 1 }, activity: "awaiting",
    waitingOnAgents: { kind: "message", fromThreadId: "billing-owner", reason: "Rental cleanup", since: 1 } });
  expect(threadStatus(parent)).toMatchObject({ key: "idle", busy: false });
  expect(parent.waitingOnAgents).toBeUndefined();
  expect(threadStatus(local)).toMatchObject({ key: "working", busy: true });
  expect(threadStatus(fleet)).toMatchObject({ key: "waiting", busy: false });
  const row = inboxRows([parent, local, fleet], []).find(row => row.chat.id === "ai:parent")!;
  expect(row.section).toBe("quiet");
  expect(row.chat.id).toBe("ai:parent");
  const markup = renderToStaticMarkup(createElement(InboxRowView, {
    row: { ...row, chat: { ...row.chat, icon: "🤖" } }, selected: false, compactSelected: false, place: "", onOpen() {}, onClose() {},
  }));
  expect(markup).toContain('data-status="idle"');
  expect(markup).not.toContain("Waiting on agents");
  const unread = inboxRows([{ ...parent, idleUnread: true }], [])[0];
  expect(unread).toMatchObject({ section: "attention", status: { key: "idle", attention: true } });
  expect(threadStatus({ ...parent, activity: "idle" })).toMatchObject({ key: "idle", busy: false });
});

test("status vocabulary covers every lifecycle and preserves unread", () => {
  expect(threadStatus(session("a")).key).toBe("idle");
  expect(threadStatus(session("a", { lifecycle: { kind: "waiting", target: "dispatch", reason: "Queued for execution", since: 1 } }))).toMatchObject({ key: "queued", busy: false });
  expect(threadStatus(session("a", { lifecycle: { kind: "working", phase: "thinking", since: 1 } })).key).toBe("working");
  expect(threadStatus(session("a", { lifecycle: { kind: "working", phase: "responding", since: 1 } })).key).toBe("typing");
  expect(threadStatus(session("a", { held: true, queuedMessages: [queued] }))).toMatchObject({ key: "idle", label: "Idle", attention: false });
  expect(threadStatus(session("a", { idleUnread: true }))).toMatchObject({ key: "idle", label: "Idle", attention: true });
  expect(threadStatus(session("a", { lifecycle: { kind: "archived" }, archivedAt: "2026" })).key).toBe("archived");
  expect(threadStatus(session("a", { lifecycle: { kind: "waiting", target: "agents", reason: "Need result", since: 1 } }))).toMatchObject({ key: "waiting", busy: false });
  expect(selectedAiId({ selectedChatId: "room:same-id" })).toBeNull();
  expect(selectedAiId({ selectedChatId: "ai:same-id" })).toBe("same-id");
});

test("main Kenaznia attention ranks before every other thread", () => {
  const rows = inboxRows([session("ordinary", { idleUnread: true, attentionSummary: "Needs you" }), session("manager", { manager: true, idleUnread: true, attentionSummary: "Main update" })], []);
  expect(rows.map(row => row.chat.id)).toEqual(["ai:manager", "ai:ordinary"]);
});

test("inbox rows show only the mutable topic title and state glyphs", () => {
  const named = inboxRows([session("named", { agentName: "Tainetaimu Sizhukein", name: "Fix the inbox" })], [])[0]!;
  expect(named.chat).toMatchObject({ kind: "ai", name: null, title: "Fix the inbox" });
  const markup = renderToStaticMarkup(createElement(InboxRowView, { row: named, selected: false, compactSelected: false, place: "", onOpen() {}, onClose() {} }));
  expect(markup).toContain('class="inbox-title">Fix the inbox</span>');
  expect(markup).not.toContain("Tainetaimu");
  expect(markup).not.toContain('class="inbox-subtitle"');
  expect(markup).not.toContain("Sizhukein");
  expect(markup).toMatch(/class="status-icon inbox-status"[^>]*role="img" aria-label="Idle"/);
});

test("the inbox shows idle unread and owner-provided execution detail without inventing progress",  () => {
  const unread = inboxRows([session("unread", { idleUnread: true })], [])[0]!;
  const unreadMarkup = renderToStaticMarkup(createElement(InboxRowView, {
    row: { ...unread, chat: { ...unread.chat, icon: "🤖" } }, selected: false, compactSelected: false, place: "", onOpen() {}, onClose() {},
  }));
  expect(unreadMarkup).toContain('data-glyph="unread"');
  expect(unreadMarkup).toContain('aria-label="Idle, unread"');
  expect(unreadMarkup).not.toContain('class="inbox-unread-dot"');
  expect(unreadMarkup).not.toContain("Done");

  const tools = inboxRows([session("tools", { state: "running", lifecycle: { kind: "working", phase: "waiting_on_tool", since: 1, detail: "bash, web search, agent browser" }, activity: "waiting_on_tool", activeTools: ["bash", "functions.web_search", "agent_browser"] })], [])[0]!;
  const toolsMarkup = renderToStaticMarkup(createElement(InboxRowView, {
    row: { ...tools, chat: { ...tools.chat, icon: "🤖" } }, selected: false, compactSelected: false, place: "", onOpen() {}, onClose() {},
  }));
  expect(toolsMarkup).toContain('aria-label="Working"');
  expect(toolsMarkup).toContain('title="Working — bash, web search, agent browser"');

  const working = inboxRows([session("busy", { state: "running", lifecycle: { kind: "waiting", target: "dispatch", reason: "Queued for execution", since: 1 }, activity: "queued" })], [])[0]!;
  const workingMarkup = renderToStaticMarkup(createElement(InboxRowView, {
    row: { ...working, chat: { ...working.chat, icon: "🤖" } }, selected: false, compactSelected: false, place: "", onOpen() {}, onClose() {},
  }));
  expect(workingMarkup).toContain('data-status="queued"');
  expect(workingMarkup).toContain('aria-label="Queued for execution"');
  expect(workingMarkup).toContain('data-glyph="held"');
});

test("directly discovered rows yield to the authoritative directory", () => {
  const discovered = [session("worker")];
  expect(reconcileDiscoveredSessions(discovered, [])).toEqual(discovered);
  expect(reconcileDiscoveredSessions(discovered, [session("worker", { state: "idle" })])).toEqual([]);
});

test("sync clears chats closed on another device but incoming reopen never takes focus", () => {
  const before = { sessions: [session("a")] };
  const closed = { sessions: [] };
  expect(selectionAfterSync("ai:a", before, closed)).toBeNull();
  expect(selectionAfterSync(null, closed, before)).toBeNull();
  expect(selectionAfterSync("ai:a", { ...closed, sessions: before.sessions }, before)).toBe("ai:a");
  expect(selectionAfterSync("ai:just-created", closed, before)).toBe("ai:just-created");
  const rooms = [{ id: "shared", title: "Shared", members: [], current: true }];
  expect(selectionAfterSync("room:shared", { ...before, rooms }, { ...before, rooms: [{ ...rooms[0]!, current: false }] })).toBeNull();
  expect(selectionAfterSync(null, { ...before, rooms: [] }, { ...before, rooms })).toBeNull();
});


test("chosen titles remain title-only in both ordinary and compact selected lists", () => {
  for (const [name, agentName] of [["Thread titles", "Saihiramei Teheitain"], ["Nebulani reference", "Nozanoshinei Lomekein"]]) {
    const original = session("named", { name, agentName });
    const before = JSON.stringify(original);
    const row = inboxRows([original], [])[0]!;
    for (const compactSelected of [false, true]) {
      const html = renderToStaticMarkup(createElement(InboxRowView, { row, selected: true, compactSelected, place: "", onOpen() {}, onClose() {} }));
      expect(html).toContain(`class="inbox-title">${name}</span>`);
      expect(html).not.toContain(agentName.split(" ")[0]!);
      expect(html).not.toContain('class="inbox-subtitle"');
    }
    expect(JSON.stringify(original)).toBe(before);
  }
});
