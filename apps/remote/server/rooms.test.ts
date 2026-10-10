import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rooms } from "./rooms";
import { handleAgentRooms, roomPersonUids } from "./agent-rooms";
import { oneKenanEnabled as roomsEnabled } from "kenan-memory/config";
import { handleRoomOwner, publicRoomSnapshot as projectRoomSnapshot, RoomHistoryError, type RoomHistory } from "./rooms-owner";
import { createHash } from "node:crypto";
import { roomAudienceResolver } from "./room-audience.mjs";
import { roomInput, roomInstructions, readRoomInput, ROOM_HISTORY_LIMIT } from "../shared/rooms";
import type { RoomMember } from "../shared/rooms";
import { deriveThreadLifecycle, type ThreadLifecycle, type ExecutionPhase, type AgentWait } from "pi-orchestrator/api";
import { ReconcileReplica } from "../shared/reconcile";

const people: RoomMember[] = [{ user: "alice", displayName: "Alice" }, { user: "bob", displayName: "Bob" }, { user: "cara", displayName: "Cara" }];
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function historyPage(messages: unknown[], extra: Partial<RoomHistory> = {}): RoomHistory {
  return { messages, live: "", paging: { revision: "fixture-revision", total: messages.length, start: 0, end: messages.length, hasOlder: false, nextBefore: null }, ...extra };
}
function publicRoomSnapshot(thread: Parameters<typeof projectRoomSnapshot>[0], source: Omit<RoomHistory, "paging">) {
  return projectRoomSnapshot(thread, historyPage(source.messages, source));
}
const request = (path: string, method = "GET", body?: unknown, actor = "alice") => new Request(`http://fixture${path}`, { method,
  headers: { "x-pi-remote-user": actor, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kenan-rooms-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "rooms.sqlite3");
  const threads = new Map<string, any>();
  const history = new Map<string, any[]>();
  const inputs: { owner: string; actor: string; text: string }[] = [];
  const notices = new Map<string, Set<string>>();
  const questions = new Map<string, any[]>();
  const calls: { path: string; method: string }[] = [];
  let unavailable = false;
  let statusUnavailable = false;
  const sent = new Set<string>();
  const listeners = new Set<(id: string) => void>();
  const transport = async (owner: string, actor: string, path: string, method: string, body?: unknown, signal?: AbortSignal) => {
    calls.push({ path, method });
    if (unavailable && path.endsWith("/notify")) return Response.json({}, { status: 503 });
    if (statusUnavailable && method === "GET") return Response.json({}, { status: 503 });
    return handleRoomOwner(new Request(request(path, method, body, actor), { signal }), {
      get: id => threads.get(id) ?? null,
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      create: async (id, title, members) => { threads.set(id, { id, title, lifecycle: { kind: "idle" }, state: "idle", metadata: { room: { id, members } } }); history.set(id, []); },
      update: async (id, members) => { threads.get(id).metadata.room.members = members; },
      send: async (id, receipt, text) => {
        if (sent.has(receipt)) return;
        sent.add(receipt);
        threads.get(id).state = "running";
        threads.get(id).lifecycle = { kind: "working", phase: "queued", since: 10 };
        threads.get(id).executionActivity = { activity: "queued", activitySince: 10, lastActivityAt: 10, activeTools: [] };
        inputs.push({ owner, actor, text }); history.get(id)!.push({ role: "user", timestamp: 10, content: text });
      },
      history: async (id, options) => {
        const all = history.get(id) ?? [];
        const revision = createHash("sha256").update(JSON.stringify(all)).digest("hex");
        if (options.revision !== undefined && options.revision !== revision) throw new RoomHistoryError(409, "Room history revision changed");
        const end = options.before ?? all.length;
        if (end > all.length) throw new RoomHistoryError(400, "Room history cursor is ahead of source");
        const start = Math.max(0, end - (options.limit ?? ROOM_HISTORY_LIMIT));
        return historyPage(all.slice(start, end).map((message, i) => ({ ...message, identity: message.identity ?? { id: `record:${start + i}` } })), {
          questions: questions.get(id) ?? [], paging: { revision, total: all.length, start, end, hasOlder: start > 0, nextBefore: start > 0 ? start : null },
        });
      },
      stop: async id => { threads.get(id).state = "idle"; threads.get(id).lifecycle = { kind: "idle" }; },
      answer: async (id, questionId) => { questions.set(id, (questions.get(id) ?? []).filter(question => question.id !== questionId)); threads.get(id).state = "running"; threads.get(id).lifecycle = { kind: "working", phase: "queued", since: 10 }; },
      notify: (id, receipt) => { const set = notices.get(owner) ?? new Set(); set.add(receipt); notices.set(owner, set); },
    });
  };
  const rooms = new Rooms(path, () => people, transport); cleanup.push(() => rooms.close());
  const id = crypto.randomUUID();
  const create = () => rooms.handle(request("/v1/rooms", "POST", { requestId: id, title: "House", members: ["bob"] }), "alice");
  return { rooms, id, create, path, threads, history, questions, calls, notices, inputs, transport, listeners,
    changed: () => { for (const listener of listeners) listener(id); }, unavailable: (value: boolean) => { unavailable = value; }, statusUnavailable: (value: boolean) => { statusUnavailable = value; } };
}

test("rooms are off unless the host explicitly opts in; reading doesn't create state", () => {
  const root = mkdtempSync(join(tmpdir(), "kenan-room-flag-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "host.json");
  expect(roomsEnabled({ PI_STACK_HOST_CONFIG: path })).toBe(false);
  writeFileSync(path, "{}"); expect(roomsEnabled({ PI_STACK_HOST_FILE: path })).toBe(false);
  writeFileSync(path, '{"oneKenan":true}'); expect(roomsEnabled({ PI_STACK_HOST_CONFIG: path })).toBe(true);
});

test("two members discover and speak in one owned thread; a third can't enumerate or open it", async () => {
  const f = fixture(); expect((await f.create()).status).toBe(201);
  const alice = await (await f.rooms.handle(request("/v1/rooms"), "alice")).json();
  const bob = await (await f.rooms.handle(request("/v1/rooms"), "bob")).json();
  const cara = await (await f.rooms.handle(request("/v1/rooms"), "cara")).json();
  expect(alice.rooms[0]).toMatchObject({ id: f.id, members: bob.rooms[0].members, current: true, unreadCount: 0 });
  expect(bob.rooms[0].unreadCount).toBe(1); expect(cara.rooms).toEqual([]);
  expect((await f.rooms.handle(request(`/v1/rooms/${f.id}`), "cara")).status).toBe(404);
  expect((await f.rooms.handle(request(`/v1/rooms/${f.id}/prompt`, "POST", { requestId: crypto.randomUUID(), text: "Hello", sender: "alice", owner: "cara" }), "bob")).status).toBe(202);
  expect(f.inputs[0]).toMatchObject({ owner: "pi-rooms", actor: "bob" });
  expect(readRoomInput(f.inputs[0]!.text)).toEqual({ sender: people[1], text: "Hello" });
  expect((await (await f.rooms.handle(request(`/v1/rooms/${f.id}`), "alice")).json()).messages[0].sender.user).toBe("bob");
  expect(f.threads.size).toBe(1);
});

test("members can add known people, but not while Kenan is speaking", async () => {
  const f = fixture(); await f.create();
  f.threads.get(f.id).state = "running";
  f.threads.get(f.id).lifecycle = { kind: "working", phase: "thinking", since: 10 };
  expect((await f.rooms.handle(request(`/v1/rooms/${f.id}/members`, "POST", { members: ["cara"] }), "bob")).status).toBe(409);
  f.threads.get(f.id).state = "idle";
  f.threads.get(f.id).lifecycle = { kind: "idle" };
  expect((await f.rooms.handle(request(`/v1/rooms/${f.id}/members`, "POST", { members: ["unknown"] }), "bob")).status).toBe(400);
  expect((await f.rooms.handle(request(`/v1/rooms/${f.id}/members`, "POST", { members: ["cara"] }), "bob")).status).toBe(200);
  expect((await f.rooms.handle(request(`/v1/rooms/${f.id}`), "cara")).status).toBe(200);
  expect(roomInstructions(f.threads.get(f.id).metadata.room)).toContain('"user":"cara"');
});

test("room creation retries retain custody; directory and notification outbox survive restart", async () => {
  const f = fixture(); f.unavailable(true); await f.create(); await f.rooms.tick();
  const restarted = new Rooms(f.path, () => people, f.transport); cleanup.push(() => restarted.close());
  f.unavailable(false); await restarted.tick();
  const listed = await (await restarted.handle(request("/v1/rooms"), "bob")).json();
  expect(listed.rooms[0].id).toBe(f.id);
  expect(f.notices.get("bob")?.has(`room-invite:${f.id}`)).toBe(true);
  expect((await f.create()).status).toBe(201); expect(f.threads.size).toBe(1);
  expect((await f.rooms.handle(request("/v1/rooms", "POST", { requestId: f.id, title: "House", members: ["bob"] }), "cara")).status).toBe(409);
});

test("assistant completions notify every member exactly once in their own ledger", async () => {
  const f = fixture(); await f.create();
  f.history.get(f.id)!.push({ role: "assistant", timestamp: 20, identity: { id: "native-final" }, content: [{ type: "text", text: "Hello both" }] });
  await f.rooms.tick(); await f.rooms.tick();
  for (const user of ["alice", "bob"]) expect(f.notices.get(user)?.has(`room-reply:${f.id}:native-final`)).toBe(true);
  expect(f.notices.get("alice")?.size).toBe(1);
  expect(f.notices.get("cara")).toBeUndefined();
});

test("unprivileged room work is transparent, including thinking, tool calls/results and local notices", () => {
  const id = crypto.randomUUID();
  const snapshot = publicRoomSnapshot({ id, title: "House", lifecycle: { kind: "idle" }, state: "idle", metadata: { room: { id, members: people.slice(0, 2) } } }, { live: "Public live text", messages: [
    { role: "user", timestamp: 1, content: roomInput(people[1]!, "Visible input") },
    { role: "user", timestamp: 2, content: "<agent_message>private worker details</agent_message>" },
    { role: "custom", content: "private custom message" },
    { role: "toolResult", content: [{ type: "text", text: "a private file" }] },
    { role: "assistant", timestamp: 3, content: [{ type: "thinking", thinking: "Alice's private medical record" }, { type: "toolCall", name: "read", arguments: { path: "/secret" } }, { type: "text", text: "Visible answer", textSignature: "hidden-provider-field" }] },
  ] });
  expect(snapshot.messages.map(message => message.text)).toEqual(["Visible input", "Visible answer"]);
  const encoded = JSON.stringify(snapshot.work); expect(encoded).toContain("private custom message"); expect(encoded).toContain("/secret"); expect(encoded).toContain("Alice's private medical record");
  expect(snapshot.work?.map(item => item.kind)).toEqual(["notice", "notice", "toolResult", "thinking", "toolCall"]);
});

test("room startup failure remains visible even before a user message enters native history", () => {
  const id = crypto.randomUUID();
  const snapshot = publicRoomSnapshot({ id, title: "House", lifecycle: { kind: "failed", reason: "Room tools did not initialize", control: "none" }, state: "idle", held: true, metadata: { room: { id, members: people.slice(0, 2) } } }, {
    live: "", error: "Room tools did not initialize", messages: [
      { role: "notice", content: { type: "model_change", provider: "openai-codex" } },
      { role: "notice", content: { type: "thinking_level_change", thinkingLevel: "high" } },
    ],
  });
  expect(snapshot.messages).toEqual([]);
  expect(snapshot.error).toBe("Room tools did not initialize");
  expect(snapshot.held).toBe(true);
  expect(snapshot.work?.map(item => item.kind)).toEqual(["model change", "thinking level change"]);
});

test("room input receipts retain their identity as work, while materialized input renders only once", () => {
  const id = crypto.randomUUID();
  const thread = { id, title: "House", lifecycle: { kind: "idle" } as ThreadLifecycle, state: "idle" as const, metadata: { room: { id, members: people.slice(0, 2) } } };
  const receipt = { role: "notice", identity: { id: "receipt" }, content: { type: "custom", customType: "thread_input", timestamp: "2026-10-03T23:00:00Z", data: { workId: "work", message: roomInput(people[1]!, "Hello") } } };
  const rejection = { role: "notice", content: { type: "custom", customType: "thread_rejected", data: { error: "fetch failed" } } };
  const failed = publicRoomSnapshot(thread, { live: "", error: "fetch failed", messages: [receipt, rejection] });
  expect(failed.messages).toEqual([]);
  expect(failed.work?.map(item => item.kind)).toEqual(["thread input", "thread rejected"]);
  expect(failed.work?.[0]).toMatchObject({ id: "receipt", text: expect.stringContaining("Hello") });
  expect(failed.error).toBe("fetch failed");
  const accepted = publicRoomSnapshot(thread, { live: "", messages: [receipt, { role: "user", content: receipt.content.data.message }, { role: "assistant", content: "Hi" }] });
  expect(accepted.messages.map(message => message.text)).toEqual(["Hello", "Hi"]);
});

test("a private thread is never converted into a room and a member cannot remove others", async () => {
  const f = fixture(); f.threads.set(f.id, { id: f.id, title: "Private", lifecycle: { kind: "idle" }, state: "idle", metadata: {} });
  expect((await f.create()).status).toBe(409);
  f.threads.delete(f.id); await f.create();
  const response = await handleRoomOwner(request(`/v1/room-owner/${f.id}/members`, "POST", { members: [people[0]] }), {
    get: id => f.threads.get(id), create: async () => {}, update: async () => {}, send: async () => {}, history: async () => historyPage([]), notify: () => {},
  });
  expect(response.status).toBe(400);
});

test("root's read-only audience attestation uses the current directory and never downgrades an unknown room token", async () => {
  const f = fixture(); await f.create();
  const audience = roomAudienceResolver(f.path);
  expect(audience("alice", f.id)).toBeUndefined();
  expect(audience("pi-rooms", f.id)).toEqual({ roomId: f.id, people: ["alice", "bob"] });
  expect(() => audience("pi-rooms", crypto.randomUUID())).toThrow("no current room directory attestation");
  await f.rooms.handle(request(`/v1/rooms/${f.id}/members`, "POST", { members: ["cara"] }), "bob");
  expect(audience("pi-rooms", f.id)?.people).toEqual(["alice", "bob", "cara"]);
});

async function directoryRoom(rooms: Rooms, actor = "alice") {
  return (await (await rooms.handle(request("/v1/rooms"), actor)).json()).rooms[0];
}

test("closing and reading are caller-local, durable and directory-only; new input reopens recipients", async () => {
  const f = fixture(); await f.create(); await f.rooms.tick();
  const before = await directoryRoom(f.rooms, "bob");
  for (const actor of ["alice", "bob"]) {
    const calls = f.calls.length;
    expect((await f.rooms.handle(request(`/v1/rooms/${f.id}/close`, "POST", {}), actor)).status).toBe(200);
    expect(f.calls.length).toBe(calls);
    expect((await directoryRoom(f.rooms, actor)).current).toBe(false);
  }
  const calls = f.calls.length;
  const read = await (await f.rooms.handle(request(`/v1/rooms/${f.id}/read`, "POST", {}), "bob")).json();
  expect(read.room).toMatchObject({ current: false, unreadCount: 0, updatedAt: before.updatedAt });
  expect(f.calls.length).toBe(calls);
  expect(f.threads.get(f.id).metadata.room.members).toHaveLength(2);
  const restarted = new Rooms(f.path, () => people, f.transport); cleanup.push(() => restarted.close());
  expect(await directoryRoom(restarted, "bob")).toMatchObject({ current: false, unreadCount: 0 });
  const receipt = crypto.randomUUID();
  await restarted.handle(request(`/v1/rooms/${f.id}/prompt`, "POST", { requestId: receipt, text: "Back again" }), "alice");
  expect(await directoryRoom(restarted, "alice")).toMatchObject({ current: true, state: "running", unreadCount: 0 });
  expect(await directoryRoom(restarted, "bob")).toMatchObject({ current: true, state: "running", unreadCount: 1 });
  f.threads.get(f.id).state = "idle";
  f.threads.get(f.id).lifecycle = { kind: "idle" };
  await restarted.tick();
  const lastActivity = (await directoryRoom(restarted)).updatedAt;
  await restarted.handle(request(`/v1/rooms/${f.id}/close`, "POST", {}), "alice");
  await restarted.handle(request(`/v1/rooms/${f.id}/close`, "POST", {}), "bob");
  await restarted.handle(request(`/v1/rooms/${f.id}/prompt`, "POST", { requestId: receipt, text: "Back again" }), "alice");
  expect(await directoryRoom(restarted, "bob")).toMatchObject({ current: false, unreadCount: 1 });
  expect(await directoryRoom(restarted, "alice")).toMatchObject({ current: false, state: "idle", updatedAt: lastActivity });
  expect((await restarted.handle(request(`/v1/rooms/${f.id}/open`, "POST", {}), "bob")).status).toBe(200);
  expect(await directoryRoom(restarted, "bob")).toMatchObject({ current: true, unreadCount: 1 });
  for (const action of ["close", "open", "read"]) expect((await restarted.handle(request(`/v1/rooms/${f.id}/${action}`, "POST", {}), "cara")).status).toBe(404);
});

test("tick caches work/questions; read leaves questions pending; only fresh replies reopen closed rooms", async () => {
  const f = fixture(); await f.create();
  const question = { id: "question-1", threadId: f.id, question: "Which day?", suggestions: [], createdAt: Date.now() };
  f.questions.set(f.id, [question]); f.threads.get(f.id).state = "running"; f.threads.get(f.id).lifecycle = { kind: "working", phase: "thinking", since: 10 };
  await f.rooms.tick();
  expect(await directoryRoom(f.rooms)).toMatchObject({ state: "running", pendingQuestions: 1, unreadCount: 1 });
  await f.rooms.handle(request(`/v1/rooms/${f.id}/read`, "POST", {}), "alice");
  expect(await directoryRoom(f.rooms)).toMatchObject({ pendingQuestions: 1, unreadCount: 0 });
  await f.rooms.handle(request(`/v1/rooms/${f.id}/close`, "POST", {}), "bob");
  await f.rooms.tick();
  expect((await directoryRoom(f.rooms, "bob")).current).toBe(false);
  await f.rooms.handle(request(`/v1/rooms/${f.id}/questions/${question.id}/answer`, "POST", { text: "Friday", selectedSuggestionIds: [] }), "alice");
  expect(await directoryRoom(f.rooms)).toMatchObject({ pendingQuestions: 0, state: "running" });
  expect((await directoryRoom(f.rooms, "bob")).current).toBe(true);
  await f.rooms.handle(request(`/v1/rooms/${f.id}/close`, "POST", {}), "alice");
  expect((await directoryRoom(f.rooms)).state).toBe("running");
  await f.rooms.handle(request(`/v1/rooms/${f.id}/abort`, "POST", {}), "bob");
  expect((await directoryRoom(f.rooms)).state).toBe("idle");
  f.history.get(f.id)!.push({ role: "assistant", timestamp: Date.now(), identity: { id: "reply-1" }, content: "Friday it is" });
  await f.rooms.tick();
  expect(await directoryRoom(f.rooms)).toMatchObject({ current: true, state: "idle", unreadCount: 1, pendingQuestions: 0 });
  await f.rooms.handle(request(`/v1/rooms/${f.id}/close`, "POST", {}), "alice");
  await f.rooms.handle(request(`/v1/rooms/${f.id}/read`, "POST", {}), "alice");
  await f.rooms.tick(); await f.rooms.tick();
  expect(await directoryRoom(f.rooms)).toMatchObject({ current: false, unreadCount: 0 });
  const unchangedAt = (await directoryRoom(f.rooms)).updatedAt;
  await f.rooms.tick(); expect((await directoryRoom(f.rooms)).updatedAt).toBe(unchangedAt);
  f.history.get(f.id)!.push({ role: "assistant", timestamp: Date.now(), identity: { id: "reply-2" }, content: "One more thing" });
  await f.rooms.tick();
  expect(await directoryRoom(f.rooms)).toMatchObject({ current: true, unreadCount: 1 });
});

test("room wait evidence survives projection and unsupported owner phases are explicit defects", () => {
  const id = crypto.randomUUID();
  const dependency: AgentWait = { kind: "job", jobId: "job-1", reason: "Result", since: 100 };
  const thread = { id, title: "House", lifecycle: { kind: "waiting", target: "job", reason: dependency.reason, since: dependency.since, dependency } as ThreadLifecycle,
    state: "waiting" as const, metadata: { room: { id, members: people.slice(0, 2) }, agentWait: dependency } };
  const snapshot = publicRoomSnapshot(thread, { messages: [], live: "" });
  expect(snapshot).toMatchObject({ lifecycle: thread.lifecycle, activity: "awaiting", waitingOnAgents: dependency });
  expect(snapshot.room.waitingOnAgents).toEqual(dependency);
  const invalid = { reason: "Result", threadIds: [], since: 100 } as unknown as AgentWait;
  const invalidLifecycle = deriveThreadLifecycle({ archived: false, cancelling: false, execution: null, pending: null, delay: null, subscriptions: [],
    dependency: invalid, error: null, updatedAt: 100 });
  const failed = publicRoomSnapshot({ ...thread, lifecycle: invalidLifecycle, metadata: { ...thread.metadata, agentWait: invalid } }, { messages: [], live: "" });
  expect(failed).toMatchObject({ lifecycle: { kind: "failed", control: "cancel_wait" }, activity: "status_error", error: "Invalid owned dependency wait" });
  const unsupported = publicRoomSnapshot({ ...thread, lifecycle: { kind: "working", phase: "future", since: 100 } as any }, { messages: [], live: "" });
  expect(unsupported).toMatchObject({ activity: "status_error", error: expect.stringContaining("supported execution phase") });
});

test("room owner transports owned phases, clocks, tools and failures without unrelated metadata", () => {
  const id = crypto.randomUUID();
  const thread = { id, title: "House", state: "running" as const, metadata: { room: { id, members: people.slice(0, 2) }, rootPrivate: "outside room" } };
  const phases: ExecutionPhase[] = ["queued", "admitting", "starting", "preparing", "thinking", "responding", "preparing_tool", "waiting_on_tool", "waiting_for_model", "waiting_on_agents", "compacting", "retrying", "waiting_for_capacity", "waiting_to_retry", "finishing", "cancelling", "recovering"];
  for (const phase of phases) {
    const evidence = { activity: phase, activitySince: 100, lastActivityAt: 150, activityDetail: `Owned ${phase}`, activeTools: phase === "waiting_on_tool" ? ["bash", "read"] : [] };
    const lifecycle: ThreadLifecycle = { kind: "working", phase, since: 100, detail: `Owned ${phase}` };
    const snapshot = publicRoomSnapshot({ ...thread, lifecycle, executionActivity: evidence }, { messages: [], live: "" });
    expect(snapshot).toMatchObject({ lifecycle, ...evidence });
    expect(snapshot.room).toMatchObject({ lifecycle, ...evidence });
    expect(JSON.stringify(snapshot)).not.toContain("outside room");
  }
  const failed = publicRoomSnapshot({ ...thread, lifecycle: { kind: "failed", reason: "Room startup failed", control: "none" }, state: "idle", held: true }, { messages: [], live: "" });
  expect(failed).toMatchObject({ activity: "status_error", held: true, executionError: "Room startup failed", error: "Room startup failed", activeTools: [] });
  const execution = { activity: "waiting_on_tool" as const, activeTools: ["bash"], activitySince: 90, lastActivityAt: 95 };
  const lifecycle: ThreadLifecycle = { kind: "working", phase: "waiting_on_tool", since: 90 };
  const live = publicRoomSnapshot({ ...thread, lifecycle, executionActivity: execution }, { messages: [], live: "", execution: { activity: "idle", activeTools: [] } });
  expect(live).toMatchObject({ lifecycle, activity: "waiting_on_tool", activeTools: ["bash"], activitySince: 90, lastActivityAt: 95 });
  const missingPhase = deriveThreadLifecycle({ archived: false, cancelling: false, execution: { since: 100, activity: { activeTools: [] } as any }, pending: null,
    dependency: null, subscriptions: [], delay: null, error: null, updatedAt: 100 });
  expect(publicRoomSnapshot({ ...thread, lifecycle: missingPhase }, { messages: [], live: "" })).toMatchObject({ activity: "status_error", error: "Execution owner did not report its activity" });
});

test("directory startup and owner reconciliation refresh evidence and expose retrieval failures", async () => {
  const f = fixture(); await f.create();
  const thread = f.threads.get(f.id);
  thread.state = "running";
  thread.lifecycle = { kind: "working", phase: "waiting_on_tool", since: 10, detail: "Owned tools" };
  thread.executionActivity = { activity: "waiting_on_tool", activitySince: 10, lastActivityAt: 20, activityDetail: "Owned tools", activeTools: ["bash"] };
  await f.rooms.tick();
  expect(await directoryRoom(f.rooms)).toMatchObject(thread.executionActivity);
  const restarted = new Rooms(f.path, () => people, f.transport); cleanup.push(() => restarted.close());
  thread.lifecycle = { kind: "working", phase: "responding", since: 30, detail: "Response text streaming" };
  thread.executionActivity = { activity: "responding", activitySince: 30, lastActivityAt: 40, activityDetail: "Response text streaming", activeTools: [] };
  expect(await directoryRoom(restarted)).toMatchObject(thread.executionActivity);
  expect((await (await restarted.handle(request(`/v1/rooms/${f.id}`), "bob")).json())).toMatchObject({ ...thread.executionActivity, room: thread.executionActivity });
  f.statusUnavailable(true);
  await restarted.tick();
  const failed = await directoryRoom(restarted);
  expect(failed).toMatchObject({ activity: "status_error", error: "Room owner status retrieval failed: HTTP 503", activeTools: [] });
  expect(failed.activitySince).toBeUndefined(); expect(failed.lastActivityAt).toBeUndefined();
  thread.state = "idle"; thread.held = true; thread.lifecycle = { kind: "failed", reason: "Room execution failed", control: "none" };
  f.statusUnavailable(false);
  await restarted.tick();
  expect(await directoryRoom(restarted)).toMatchObject({ state: "idle", activity: "status_error", held: true, error: "Room execution failed", activeTools: [] });
  const calls = f.calls.length;
  expect((await (await restarted.handle(request("/v1/rooms"), "cara")).json()).rooms).toEqual([]);
  expect(f.calls.length).toBe(calls);
});

test("owner status transport exceptions do not leave persisted running activity in a restarted directory", async () => {
  const f = fixture(); await f.create();
  f.threads.get(f.id).state = "running";
  f.threads.get(f.id).lifecycle = { kind: "working", phase: "thinking", since: 10 };
  f.threads.get(f.id).executionActivity = { activity: "thinking", activitySince: 10, lastActivityAt: 20, activeTools: [] };
  await f.rooms.tick();
  const restarted = new Rooms(f.path, () => people, async () => { throw new Error("Private transport diagnostic"); }); cleanup.push(() => restarted.close());
  const room = await directoryRoom(restarted);
  expect(room).toMatchObject({ state: "running", activity: "status_error", error: "Room owner status retrieval failed", activeTools: [] });
  expect(JSON.stringify(room)).not.toContain("Private transport diagnostic");
});

test("room owner rereads lifecycle after awaited history inspection", async () => {
  const id = crypto.randomUUID();
  let thread: any = { id, title: "House", lifecycle: { kind: "working", phase: "thinking", since: 10 }, state: "running", executionActivity: { activity: "thinking", activeTools: [] }, metadata: { room: { id, members: people.slice(0, 2) } } };
  const response = await handleRoomOwner(request(`/v1/room-owner/${id}`), {
    get: () => thread, create: async () => {}, update: async () => {}, send: async () => {}, notify: () => {},
    history: async () => { thread = { ...thread, lifecycle: { kind: "idle" }, state: "idle", held: true }; return historyPage([]); },
  });
  expect(await response.json()).toMatchObject({ state: "idle", activity: "idle", held: true, activeTools: [] });
});

test("adding a member reopens existing recipients and invites the new recipient", async () => {
  const f = fixture(); await f.create();
  await f.rooms.handle(request(`/v1/rooms/${f.id}/close`, "POST", {}), "bob");
  await f.rooms.handle(request(`/v1/rooms/${f.id}/members`, "POST", { members: ["cara"] }), "alice");
  expect(await directoryRoom(f.rooms, "bob")).toMatchObject({ current: true, unreadCount: 2 });
  expect(await directoryRoom(f.rooms, "cara")).toMatchObject({ current: true, unreadCount: 1 });
});

test("existing directory rows gain inbox defaults without custody or history migration", async () => {
  const root = mkdtempSync(join(tmpdir(), "kenan-room-upgrade-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "rooms.sqlite3"); const id = crypto.randomUUID();
  const db = new Database(path, { create: true });
  db.exec("CREATE TABLE rooms(id TEXT PRIMARY KEY,owner TEXT NOT NULL,title TEXT NOT NULL,members TEXT NOT NULL,ready INTEGER NOT NULL DEFAULT 0)");
  db.query("INSERT INTO rooms VALUES(?,?,?,?,1)").run(id, "alice", "Before upgrade", JSON.stringify(people.slice(0, 2)));
  db.exec("CREATE TABLE deliveries(receipt TEXT NOT NULL,room TEXT NOT NULL,person TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,time INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(receipt,person))");
  db.query("INSERT INTO deliveries(receipt,room,person,title,body,time) VALUES(?,?,?,?,?,?)").run(`room-invite:${id}`, id, "bob", "Before upgrade", "Invitation", 123); db.close();
  const rooms = new Rooms(path, () => people, async () => { throw new Error("Must not contact private custodian"); }); cleanup.push(() => rooms.close());
  expect(await directoryRoom(rooms)).toMatchObject({ id, current: true, state: "idle", unreadCount: 0, pendingQuestions: 0 });
  expect((await directoryRoom(rooms)).updatedAt).toBe(123);
  expect(await directoryRoom(rooms, "bob")).toMatchObject({ unreadCount: 1 });
  expect((await rooms.handle(request(`/v1/rooms/${id}/read`, "POST", {}), "bob")).status).toBe(200);
  expect(await directoryRoom(rooms, "bob")).toMatchObject({ unreadCount: 0 });
  expect((await rooms.handle(request(`/v1/rooms/${id}/close`, "POST", {}), "bob")).status).toBe(200);
  expect((await rooms.handle(request(`/v1/rooms/${id}`), "bob")).status).toBe(503);
});

test("agent room access is kernel-person bound; identity hints never grant membership", async () => {
  const f = fixture(); await f.create();
  const uids = roomPersonUids(people.map(person => person.user), user => ({ alice: 1001, bob: 1002, cara: 1003 })[user]);
  const access = (path: string, uid?: number, method = "GET", body?: unknown) => handleAgentRooms(request(path, method, body, "alice"), uid === undefined ? undefined : { uid }, uids, f.rooms);
  for (const uid of [undefined, 0, 9999]) expect((await access("/v1/agent-rooms?user=alice&session=forged", uid)).status).toBe(403);
  expect((await (await access("/v1/agent-rooms", 1003)).json()).rooms).toEqual([]);
  expect((await access(`/v1/agent-rooms/${f.id}?user=alice`, 1003)).status).toBe(404);
  expect((await access(`/v1/agent-rooms/${f.id}/prompt`, 1003, "POST", { requestId: crypto.randomUUID(), text: "Forbidden", sender: "alice" })).status).toBe(404);
  const listed = await (await access("/v1/agent-rooms", 1002)).json();
  expect(listed.rooms.map((room: any) => room.id)).toEqual([f.id]);
  f.history.get(f.id)!.push({ role: "assistant", timestamp: 1, content: [{ type: "text", text: "Visible shared answer" }, { type: "thinking", thinking: "Transparent work" }] });
  const snapshot = await (await access(`/v1/agent-rooms/${f.id}`, 1002)).json();
  expect(snapshot.messages.at(-1).text).toBe("Visible shared answer");
  expect(snapshot.work).toContainEqual(expect.objectContaining({ kind: "thinking", text: "Transparent work" }));
  expect((await directoryRoom(f.rooms, "bob")).unreadCount).toBeGreaterThan(0);
  for (const path of ["/v1/agent-rooms/../room-owner/" + f.id, `/v1/agent-rooms/${f.id}/members`, `/v1/agent-rooms/${f.id}/abort`]) expect((await access(path, 1002, "POST", {})).status).toBe(404);
  const ownId = crypto.randomUUID();
  expect((await access("/v1/agent-rooms", 1002, "POST", { requestId: ownId, title: "Own room", members: ["alice", "cara"] })).status).toBe(201);
  expect(f.threads.get(ownId).metadata.room.members).toEqual([people[1]]);
});

test("agent posts use verified attribution and preserve receipt custody across replay", async () => {
  const f = fixture(); await f.create();
  const uids = new Map([[1002, "bob"]]);
  const receipt = crypto.randomUUID();
  const post = (text = "Answer from my thread") => handleAgentRooms(request(`/v1/agent-rooms/${f.id}/prompt`, "POST", { requestId: receipt, text, sender: "alice", senderKind: "person", user: "alice" }), { uid: 1002 }, uids, f.rooms);
  expect((await post()).status).toBe(202);
  expect((await post()).status).toBe(202);
  const restarted = new Rooms(f.path, () => people, f.transport); cleanup.push(() => restarted.close());
  expect(await (await handleAgentRooms(request(`/v1/agent-rooms/${f.id}/prompt`, "POST", { requestId: receipt, text: "Answer from my thread" }), { uid: 1002 }, uids, restarted)).json()).toMatchObject({ accepted: true, replayed: true });
  expect((await post("Changed text")).status).toBe(409);
  expect(f.inputs).toHaveLength(1);
  expect(readRoomInput(f.inputs[0]!.text)).toEqual({ sender: { ...people[1], displayName: "Bob's Kenan", agent: true }, text: "Answer from my thread" });
  expect((await (await f.rooms.handle(request(`/v1/rooms/${f.id}`), "alice")).json()).messages[0].sender).toMatchObject({ user: "bob", agent: true, displayName: "Bob's Kenan" });
  const humanReceipt = crypto.randomUUID();
  await f.rooms.handle(request(`/v1/rooms/${f.id}/prompt`, "POST", { requestId: humanReceipt, text: "Human", senderKind: "agent" }), "alice");
  expect(readRoomInput(f.inputs.at(-1)!.text)?.sender).toEqual(people[0]);
  expect((await handleAgentRooms(request(`/v1/agent-rooms/${f.id}/prompt`, "POST", { requestId: humanReceipt, text: "Human" }), { uid: 1002 }, uids, f.rooms)).status).toBe(409);
});

test("unchanged directory reads do not inspect room history; owner events coalesce and idle feeds do no full work", async () => {
  const f = fixture(); await f.create();
  const fullReads = () => f.calls.filter(call => call.path === `/v1/room-owner/${f.id}` && call.method === "GET").length;
  const before = fullReads();
  await directoryRoom(f.rooms); await directoryRoom(f.rooms);
  expect(fullReads()).toBe(before);
  f.rooms.start();
  await Bun.sleep(1_050);
  const initial = fullReads();
  expect(initial).toBe(before + 1);
  f.changed(); f.changed(); f.changed();
  f.history.get(f.id)!.push({ role: "assistant", timestamp: 20, identity: { id: "event-final" }, content: [{ type: "text", text: "Changed" }] });
  await Bun.sleep(1_050);
  expect(fullReads()).toBe(initial + 1);
  expect(f.notices.get("alice")?.has(`room-reply:${f.id}:event-final`)).toBe(true);
  await Bun.sleep(1_050);
  expect(fullReads()).toBe(initial + 1);
  f.rooms.close();
  expect(f.listeners.size).toBe(0);
});

test("member revisions reconnect by cursor, ignore unrelated changes, and close on authenticated-session revocation", async () => {
  const f = fixture(); await f.create();
  const controller = new AbortController();
  const response = await f.rooms.handle(new Request(request("/v1/rooms/changes"), { signal: controller.signal }), "bob");
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const revisions = JSON.parse(first.slice(6));
  expect(Object.keys(revisions.rooms)).toEqual([f.id]);
  const empty = await f.rooms.handle(request("/v1/rooms/changes"), "cara");
  const outsider = empty.body!.getReader();
  expect(JSON.parse(new TextDecoder().decode((await outsider.read()).value).slice(6)).rooms).toEqual({});
  await outsider.cancel();
  let settled = false;
  const pending = reader.read().then(value => { settled = true; return value; });
  await f.rooms.handle(request(`/v1/rooms/${f.id}/close`, "POST", {}), "cara");
  await Promise.resolve();
  expect(settled).toBe(false);
  await f.rooms.handle(request(`/v1/rooms/${f.id}/close`, "POST", {}), "bob");
  const second = JSON.parse(new TextDecoder().decode((await pending).value).slice(6));
  expect(second.cursor).not.toBe(revisions.cursor);
  expect(second.rooms).toEqual(revisions.rooms);
  const resume = new AbortController();
  const resumed = await f.rooms.handle(new Request(request(`/v1/rooms/changes?cursor=${second.cursor}`), { signal: resume.signal }), "bob");
  const resumedReader = resumed.body!.getReader();
  let replayed = false;
  const next = resumedReader.read().then(value => { replayed = true; return value; });
  await Promise.resolve(); expect(replayed).toBe(false);
  resume.abort(); expect((await next).done).toBe(true);
  controller.abort(); expect((await reader.read()).done).toBe(true);
});

test("room sync sends small patches, stays actor-partitioned, and checks membership before reconciliation", async () => {
  const f = fixture(); await f.create();
  f.history.get(f.id)!.push({ role: "assistant", timestamp: 20, identity: { id: "large-final" }, content: [{ type: "text", text: "x".repeat(10_000) }] });
  const path = `/v1/rooms/${f.id}`;
  const replica = new ReconcileReplica();
  const full = await (await f.rooms.handle(request(`${path}?sync=1`), "alice")).json();
  expect(replica.apply(full).ok).toBe(true);
  expect((await f.rooms.handle(request(`${path}?sync=1&have=${full.revision}`), "alice")).status).toBe(304);
  f.questions.set(f.id, [{ id: "new-question", question: "When?", suggestions: [], createdAt: 30 }]);
  const patch = await (await f.rooms.handle(request(`${path}?sync=1&have=${full.revision}`), "alice")).json();
  expect(patch.kind).toBe("patch");
  expect(JSON.stringify(patch).length).toBeLessThan(1_000);
  expect(replica.apply(patch).ok).toBe(true);
  const bob = await (await f.rooms.handle(request(`${path}?sync=1&have=${full.revision}`), "bob")).json();
  expect(bob.kind).toBe("full");
  expect((await f.rooms.handle(request(`${path}?sync=1&have=${full.revision}`), "cara")).status).toBe(404);
});

test("awaited room history rechecks membership before returning any body", async () => {
  const id = crypto.randomUUID();
  const thread = { id, title: "House", lifecycle: { kind: "idle" } as ThreadLifecycle, state: "idle" as const, metadata: { room: { id, members: people.slice(0, 2) } } };
  const response = await handleRoomOwner(request(`/v1/room-owner/${id}`), {
    get: () => thread, create: async () => {}, update: async () => {}, send: async () => {}, notify: () => {},
    history: async () => {
      thread.metadata.room.members = [people[1]!];
      return historyPage([{ role: "assistant", content: "No longer shared" }]);
    },
  });
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("No longer shared");
});

test("awaited room history errors recheck audience before returning diagnostics", async () => {
  const id = crypto.randomUUID();
  const thread = { id, title: "House", lifecycle: { kind: "idle" } as ThreadLifecycle, state: "idle" as const, metadata: { room: { id, members: people.slice(0, 2) } } };
  const response = await handleRoomOwner(request(`/v1/room-owner/${id}?before=1&limit=2&revision=r1`), {
    get: () => thread, create: async () => {}, update: async () => {}, send: async () => {}, notify: () => {},
    history: async (_id, options) => {
      expect(options).toEqual({ before: 1, limit: 2, revision: "r1" });
      thread.metadata.room.members = [people[1]!];
      throw new RoomHistoryError(409, "Unshared source diagnostics");
    },
  });
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("Unshared source diagnostics");
});

test("read cursors acknowledge only displayed events, not a later arrival", async () => {
  const f = fixture(); await f.create();
  const shown = await directoryRoom(f.rooms, "bob");
  await f.rooms.handle(request(`/v1/rooms/${f.id}/prompt`, "POST", { requestId: crypto.randomUUID(), text: "Later" }), "alice");
  expect((await f.rooms.handle(request(`/v1/rooms/${f.id}/read`, "POST", { through: shown.readThrough }), "bob")).status).toBe(200);
  expect((await directoryRoom(f.rooms, "bob")).unreadCount).toBe(1);
  expect((await f.rooms.handle(request(`/v1/rooms/${f.id}/read`, "POST", { through: shown.readThrough + 100 }), "bob")).status).toBe(400);
});

test("ordinary room opens are bounded; older pages preserve identities, work and exact source fences", async () => {
  const f = fixture(); await f.create();
  for (let i = 0; i < 97; i++) f.history.get(f.id)!.push(i % 2 === 0
    ? { role: "assistant", identity: { id: `native:${i}` }, content: [{ type: "text", text: `Reply ${i}` }, { type: "thinking", thinking: `Work ${i}` }] }
    : { role: "toolResult", identity: { id: `native:${i}` }, toolName: "read", content: `Result ${i}` });
  const path = `/v1/rooms/${f.id}`;
  let snapshot = await (await f.rooms.handle(request(path), "alice")).json();
  expect(snapshot.paging).toMatchObject({ start: 65, end: 97, total: 97, hasOlder: true, nextBefore: 65 });
  expect(snapshot.context).toBeUndefined();
  const seen = new Set<string>();
  const observe = () => {
    for (const item of snapshot.messages) { expect(seen.has(item.id)).toBe(false); seen.add(item.id); }
    for (const item of snapshot.work) {
      const id = item.kind === "thinking" ? item.id.slice(0, -2) : item.id;
      if (item.kind !== "thinking") { expect(seen.has(id)).toBe(false); seen.add(id); }
      else expect(snapshot.messages.some((message: any) => message.id === id)).toBe(true);
    }
  };
  observe();
  while (snapshot.paging.hasOlder) {
    const { nextBefore, revision } = snapshot.paging;
    const response = await f.rooms.handle(request(`${path}?before=${nextBefore}&limit=32&revision=${revision}`), "alice");
    expect(response.status).toBe(200);
    snapshot = await response.json();
    expect(snapshot.paging.end).toBe(nextBefore); expect(snapshot.paging.revision).toBe(revision);
    observe();
  }
  expect(seen.size).toBe(97);
  expect(snapshot.paging).toMatchObject({ start: 0, end: 1, nextBefore: null });
  const revision = snapshot.paging.revision;
  f.history.get(f.id)!.push({ role: "assistant", content: "Changed" });
  const changed = await f.rooms.handle(request(`${path}?before=1&revision=${revision}`), "alice");
  expect(changed.status).toBe(409);
  expect(await changed.json()).toEqual({ error: "Room history revision changed" });
  expect(f.calls.some(call => call.path === `/v1/room-owner/${f.id}?before=1&revision=${revision}`)).toBe(true);
});

test("invalid room history queries fail before owner reads and page sync bases are isolated", async () => {
  const f = fixture(); await f.create();
  const path = `/v1/rooms/${f.id}`;
  const calls = f.calls.length;
  for (const query of ["before=-1", "before=1.5", "limit=0", "limit=33", "revision=", "before=0&before=1", "before=9007199254740992"])
    expect((await f.rooms.handle(request(`${path}?${query}`), "alice")).status).toBe(400);
  expect(f.calls.length).toBe(calls);
  f.history.get(f.id)!.push({ role: "assistant", content: "Newest", identity: { id: "newest" } });
  const latest = await (await f.rooms.handle(request(`${path}?sync=1`), "alice")).json();
  const older = await (await f.rooms.handle(request(`${path}?before=0&sync=1&have=${latest.revision}`), "alice")).json();
  expect(older.kind).toBe("full"); expect(older.resource).toBe(`${path}?before=0`);
  expect(older.value.paging).toMatchObject({ start: 0, end: 0, total: 1 });
});

test("raw input receipt/user pairs split across pages remain transparent without duplicate chat identity", () => {
  const id = crypto.randomUUID();
  const thread = { id, title: "House", lifecycle: { kind: "idle" } as ThreadLifecycle, state: "idle" as const, metadata: { room: { id, members: people.slice(0, 2) } } };
  const input = roomInput(people[0]!, "Across pages");
  const receipt = { role: "notice", identity: { id: "receipt" }, content: { customType: "thread_input", data: { message: input } } };
  const user = { role: "user", identity: { id: "user" }, content: input };
  const first = projectRoomSnapshot(thread, historyPage([receipt], { paging: { revision: "r", total: 2, start: 0, end: 1, hasOlder: false, nextBefore: null } }));
  const second = projectRoomSnapshot(thread, historyPage([user], { paging: { revision: "r", total: 2, start: 1, end: 2, hasOlder: true, nextBefore: 1 } }));
  expect(first.messages).toEqual([]); expect(first.work?.[0]).toMatchObject({ id: "receipt", kind: "thread input", text: expect.stringContaining("Across pages") });
  expect(second.messages).toMatchObject([{ id: "user", text: "Across pages" }]);
  expect(() => projectRoomSnapshot(thread, historyPage([user], { paging: { revision: "r", total: 2, start: 1, end: 2, hasOlder: false, nextBefore: null } }))).toThrow("invalid history page");
});
