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
  cwd: "/", workspaceName: "", environment: "local", state: "idle", held: false, activity: patch.state === "running" ? "queued" : "idle", activeTools: [],
  provider: "openai", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", lastUserMessageAt: "2026-01-01T00:00:00Z", revision: 1, idleUnread: false,
  queuedMessages: [], archivedAt: null, ...patch,
});
const queued: Session["queuedMessages"][number] = { id: "q", text: "later", delivery: "queue", state: "queued", canSteer: false, canHardSteer: false, canCancel: true, createdAt: "" };
test("inbox ranks attention, then work, then quiet",  () => {
  const ai = session("same-id");
  const rows = inboxRows([
    ai,
    session("child", { parentId: ai.id, state: "running" }),
    session("held", { held: true, queuedMessages: [queued] }),
    session("unread", { idleUnread: true }),
    session("busy", { state: "running", activity: "waiting_on_tool", activeTools: ["bash"] }),
    session("parent", { activity: "awaiting", hasChildren: true, waitingOnAgents: { kind: "agents", threadIds: ["child"], reason: "Need result", since: 1 } }),
    session("old", { updatedAt: "2025-01-01T00:00:00Z", lastUserMessageAt: "2025-01-01T00:00:00Z" }),
  ], []);
  expect(rows.map(row => row.chat.id)).toEqual(["ai:unread", "ai:busy", "ai:parent", "ai:held", "ai:same-id", "ai:old"]);
  expect(rows.map(row => row.section)).toEqual(["attention", "working", "working", "quiet", "quiet", "quiet"]);
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
    { id: "shared", title: "Shared", members: [{ user: "kenan", displayName: "Hara" }], current: true, updatedAt: 10, unreadCount: 2 },
    { id: "working", title: "Working room", members: [], state: "running" as const, activity: "queued" as const, updatedAt: 20 },
    { id: "closed", title: "Closed room", members: [], current: false, unreadCount: 5 },
    { id: "question", title: "Question", members: [], pendingQuestions: 1, updatedAt: 30 },
  ];
  const rows = inboxRows([session("busy", { state: "running", updatedAt: new Date(15).toISOString(), lastUserMessageAt: new Date(15).toISOString() })], [], rooms);
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
  const local = session("local", { parentId: parent.id, state: "running", activity: "thinking" });
  const fleet = session("fleet", { parentId: parent.id, origin: "fleet", activity: "awaiting",
    waitingOnAgents: { kind: "message", fromThreadId: "billing-owner", reason: "Rental cleanup", since: 1 } });
  expect(threadStatus(parent)).toMatchObject({ key: "idle", busy: false });
  expect(parent.waitingOnAgents).toBeUndefined();
  expect(threadStatus(local)).toMatchObject({ key: "thinking", busy: true });
  expect(threadStatus(fleet)).toMatchObject({ key: "waiting_for_message", busy: true });
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

test("status vocabulary covers every lifecycle and flag", () => {
  expect(threadStatus(session("a")).key).toBe("idle");
  expect(threadStatus(session("a", { state: "running" }))).toMatchObject({ key: "queued", label: "Queued for execution", busy: true });
  expect(threadStatus(session("a", { state: "running", activity: "thinking" })).key).toBe("thinking");
  expect(threadStatus(session("a", { state: "running", activity: "waiting_on_tool", activeTools: ["functions.agent_browser"] })).label).toBe("Running agent browser");
  expect(threadStatus(session("a", { state: "running", activity: "waiting_on_tool", activeTools: ["bash", "web_search"] }))).toMatchObject({ label: "Running bash and web search", short: "2 tools" });
  expect(threadStatus(session("a", { state: "running", activity: "waiting_on_tool", activeTools: ["bash", "functions.web_search", "agent_browser"] }))).toMatchObject({ label: "Running 3 tools", short: "3 tools", title: "bash, web search, agent browser" });
  expect(threadStatus(session("a", { held: true, queuedMessages: [queued] }))).toMatchObject({ key: "idle", label: "Idle", attention: false });
  expect(threadStatus(session("a", { idleUnread: true }))).toMatchObject({ key: "idle", label: "Idle", attention: true });
  expect(threadStatus(session("a", { archivedAt: "2026" })).key).toBe("archived");
  expect(threadStatus(session("a", { activity: "awaiting", waitingOnAgents: { kind: "agents", threadIds: ["child"], reason: "Need result", since: 1 } }))).toMatchObject({ key: "awaiting", busy: true });
  expect(selectedAiId({ selectedChatId: "room:same-id" })).toBeNull();
  expect(selectedAiId({ selectedChatId: "ai:same-id" })).toBe("same-id");
});

test("inbox rows show only the mutable topic title while preserving agent identity and state glyphs", () => {
  const named = inboxRows([session("named", { agentName: "Tainetaimu Sizhukein", name: "Fix the inbox" })], [])[0]!;
  expect(named.chat).toMatchObject({ kind: "ai", name: "Tainetaimu", title: "Fix the inbox" });
  const markup = renderToStaticMarkup(createElement(InboxRowView, { row: named, selected: false, compactSelected: false, place: "", onOpen() {}, onClose() {} }));
  expect(markup).toContain('class="inbox-title">Fix the inbox</span>');
  expect(markup).not.toContain("Tainetaimu");
  expect(markup).not.toContain('class="inbox-subtitle"');
  expect(markup).not.toContain("Sizhukein");
  expect(markup).toMatch(/class="status-icon inbox-status"[^>]*role="img" aria-label="Idle"/);
});

test("the inbox shows idle unread as its own glyph and gives multi-tool names as title detail", () => {
  const unread = inboxRows([session("unread", { idleUnread: true })], [])[0]!;
  const unreadMarkup = renderToStaticMarkup(createElement(InboxRowView, {
    row: { ...unread, chat: { ...unread.chat, icon: "🤖" } }, selected: false, compactSelected: false, place: "", onOpen() {}, onClose() {},
  }));
  expect(unreadMarkup).toContain('data-glyph="unread"');
  expect(unreadMarkup).toContain('aria-label="Idle, unread"');
  expect(unreadMarkup).not.toContain('class="inbox-unread-dot"');
  expect(unreadMarkup).not.toContain("Done");

  const tools = inboxRows([session("tools", { state: "running", activity: "waiting_on_tool", activeTools: ["bash", "functions.web_search", "agent_browser"] })], [])[0]!;
  const toolsMarkup = renderToStaticMarkup(createElement(InboxRowView, {
    row: { ...tools, chat: { ...tools.chat, icon: "🤖" } }, selected: false, compactSelected: false, place: "", onOpen() {}, onClose() {},
  }));
  expect(toolsMarkup).toContain('aria-label="Running 3 tools"');
  expect(toolsMarkup).toContain('title="Running 3 tools — bash, web search, agent browser"');

  // Queued is an owned scheduling phase, not a claim of model progress.
  const working = inboxRows([session("busy", { state: "running", activity: "queued" })], [])[0]!;
  const workingMarkup = renderToStaticMarkup(createElement(InboxRowView, {
    row: { ...working, chat: { ...working.chat, icon: "🤖" } }, selected: false, compactSelected: false, place: "", onOpen() {}, onClose() {},
  }));
  expect(workingMarkup).toContain('data-status="queued"');
  expect(workingMarkup).toContain('aria-label="Queued for execution"');
  expect(workingMarkup).toContain('data-glyph="working"');
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
