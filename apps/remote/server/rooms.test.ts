import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rooms } from "./rooms";
import { handleAgentRooms, roomPersonUids } from "./agent-rooms";
import { oneKenanEnabled as roomsEnabled } from "kenan-memory/config";
import { handleRoomOwner, publicRoomSnapshot } from "./rooms-owner";
import { roomAudienceResolver } from "./room-audience.mjs";
import { roomInput, roomInstructions, readRoomInput } from "../shared/rooms";
import type { RoomMember } from "../shared/rooms";

const people: RoomMember[] = [{ user: "alice", displayName: "Alice" }, { user: "bob", displayName: "Bob" }, { user: "cara", displayName: "Cara" }];
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
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
  const transport = async (owner: string, actor: string, path: string, method: string, body?: unknown) => {
    calls.push({ path, method });
    if (unavailable && path.endsWith("/notify")) return Response.json({}, { status: 503 });
    if (statusUnavailable && method === "GET") return Response.json({}, { status: 503 });
    return handleRoomOwner(request(path, method, body, actor), {
      get: id => threads.get(id) ?? null,
      create: async (id, title, members) => { threads.set(id, { id, title, state: "idle", metadata: { room: { id, members } } }); history.set(id, []); },
      update: async (id, members) => { threads.get(id).metadata.room.members = members; },
      send: async (id, receipt, text) => {
        if (sent.has(receipt)) return;
        sent.add(receipt);
        threads.get(id).state = "running";
        threads.get(id).executionActivity = { activity: "queued", activitySince: 10, lastActivityAt: 10, activeTools: [] };
        inputs.push({ owner, actor, text }); history.get(id)!.push({ role: "user", timestamp: 10, content: text });
      },
      history: async id => ({ messages: history.get(id) ?? [], questions: questions.get(id) ?? [], live: "" }),
      stop: async id => { threads.get(id).state = "idle"; },
      answer: async (id, questionId) => { questions.set(id, (questions.get(id) ?? []).filter(question => question.id !== questionId)); threads.get(id).state = "running"; },
      notify: (id, receipt) => { const set = notices.get(owner) ?? new Set(); set.add(receipt); notices.set(owner, set); },
    });
  };
  const rooms = new Rooms(path, () => people, transport); cleanup.push(() => rooms.close());
  const id = crypto.randomUUID();
  const create = () => rooms.handle(request("/v1/rooms", "POST", { requestId: id, title: "House", members: ["bob"] }), "alice");
  return { rooms, id, create, path, threads, history, questions, calls, notices, inputs, transport, unavailable: (value: boolean) => { unavailable = value; }, statusUnavailable: (value: boolean) => { statusUnavailable = value; } };
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
  expect((await f.rooms.handle(request(`/v1/rooms/${f.id}/members`, "POST", { members: ["cara"] }), "bob")).status).toBe(409);
  f.threads.get(f.id).state = "idle";
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
  const snapshot = publicRoomSnapshot({ id, title: "House", state: "idle", metadata: { room: { id, members: people.slice(0, 2) } } }, { live: "Public live text", messages: [
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
  const snapshot = publicRoomSnapshot({ id, title: "House", state: "idle", held: true, metadata: { room: { id, members: people.slice(0, 2) } } }, {
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

test("rejected room input remains a human message, while accepted native input renders only once", () => {
  const id = crypto.randomUUID();
  const thread = { id, title: "House", state: "idle" as const, metadata: { room: { id, members: people.slice(0, 2) } } };
  const receipt = { role: "notice", identity: { id: "receipt" }, content: { type: "custom", customType: "thread_input", timestamp: "2026-10-03T23:00:00Z", data: { workId: "work", message: roomInput(people[1]!, "Hello") } } };
  const rejection = { role: "notice", content: { type: "custom", customType: "thread_rejected", data: { error: "fetch failed" } } };
  const failed = publicRoomSnapshot(thread, { live: "", error: "fetch failed", messages: [receipt, rejection] });
  expect(failed.messages.map(message => ({ text: message.text, sender: message.sender.user }))).toEqual([{ text: "Hello", sender: people[1]!.user }]);
  expect(failed.work?.map(item => item.kind)).toEqual(["thread rejected"]);
  expect(failed.error).toBe("fetch failed");
  const accepted = publicRoomSnapshot(thread, { live: "", messages: [receipt, { role: "user", content: receipt.content.data.message }, { role: "assistant", content: "Hi" }] });
  expect(accepted.messages.map(message => message.text)).toEqual(["Hello", "Hi"]);
});

test("a private thread is never converted into a room and a member cannot remove others", async () => {
  const f = fixture(); f.threads.set(f.id, { id: f.id, title: "Private", state: "idle", metadata: {} });
  expect((await f.create()).status).toBe(409);
  f.threads.delete(f.id); await f.create();
  const response = await handleRoomOwner(request(`/v1/room-owner/${f.id}/members`, "POST", { members: [people[0]] }), {
    get: id => f.threads.get(id), create: async () => {}, update: async () => {}, send: async () => {}, history: async () => ({ messages: [], live: "" }), notify: () => {},
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
  f.questions.set(f.id, [question]); f.threads.get(f.id).state = "running";
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
  const thread = { id, title: "House", state: "idle" as const, metadata: { room: { id, members: people.slice(0, 2) }, agentWait: { kind: "job" as const, jobId: "job-1", reason: "Result", since: 100 } } };
  const snapshot = publicRoomSnapshot(thread, { messages: [], live: "" });
  expect(snapshot).toMatchObject({ activity: "awaiting", waitingOnAgents: thread.metadata.agentWait });
  expect(snapshot.room.waitingOnAgents).toEqual(thread.metadata.agentWait);
  const legacy = publicRoomSnapshot({ ...thread, metadata: { ...thread.metadata, agentWait: { reason: "Result", threadIds: [], since: 100 } } }, { messages: [], live: "" });
  expect(legacy).toMatchObject({ activity: "status_error", error: expect.stringContaining("Wait reporting defect") });
  const unsupported = publicRoomSnapshot(thread, { messages: [], live: "", execution: { activity: "future", activeTools: [] } as any });
  expect(unsupported).toMatchObject({ activity: "status_error", error: expect.stringContaining("supported execution phase") });
});

test("room owner transports owned phases, clocks, tools and failures without unrelated metadata", () => {
  const id = crypto.randomUUID();
  const thread = { id, title: "House", state: "running" as const, metadata: { room: { id, members: people.slice(0, 2) }, rootPrivate: "outside room" } };
  for (const phase of ["queued", "admitting", "starting", "preparing", "thinking", "responding", "preparing_tool", "waiting_on_tool", "waiting_for_model", "compacting", "retrying", "waiting_for_capacity", "waiting_to_retry", "finishing", "cancelling", "recovering"]) {
    const evidence = { activity: phase, activitySince: 100, lastActivityAt: 150, activityDetail: `Owned ${phase}`, activeTools: phase === "waiting_on_tool" ? ["bash", "read"] : [] };
    const snapshot = publicRoomSnapshot({ ...thread, executionActivity: evidence as any }, { messages: [], live: "" });
    expect(snapshot).toMatchObject(evidence);
    expect(snapshot.room).toMatchObject(evidence);
    expect(JSON.stringify(snapshot)).not.toContain("outside room");
  }
  const failed = publicRoomSnapshot({ ...thread, state: "idle", held: true, metadata: { ...thread.metadata, executionError: "Room startup failed" } }, { messages: [], live: "" });
  expect(failed).toMatchObject({ held: true, executionError: "Room startup failed", error: "Room startup failed", activeTools: [] });
  const live = publicRoomSnapshot(thread, { messages: [], live: "", execution: { activity: "waiting_on_tool", activeTools: ["bash"], activitySince: 90, lastActivityAt: 95 } });
  expect(live).toMatchObject({ activity: "waiting_on_tool", activeTools: ["bash"], activitySince: 90, lastActivityAt: 95 });
  expect(publicRoomSnapshot(thread, { messages: [], live: "" })).toMatchObject({ activity: "status_error", error: "Room owner did not report an execution phase" });
});

test("directory polling refreshes actual owner evidence after restart and reports retrieval failure instead of stale work", async () => {
  const f = fixture(); await f.create();
  const thread = f.threads.get(f.id);
  thread.state = "running";
  thread.executionActivity = { activity: "waiting_on_tool", activitySince: 10, lastActivityAt: 20, activityDetail: "Owned tools", activeTools: ["bash"] };
  await f.rooms.tick();
  expect(await directoryRoom(f.rooms)).toMatchObject(thread.executionActivity);
  const restarted = new Rooms(f.path, () => people, f.transport); cleanup.push(() => restarted.close());
  thread.executionActivity = { activity: "responding", activitySince: 30, lastActivityAt: 40, activityDetail: "Response text streaming", activeTools: [] };
  expect(await directoryRoom(restarted)).toMatchObject(thread.executionActivity);
  expect((await (await restarted.handle(request(`/v1/rooms/${f.id}`), "bob")).json())).toMatchObject({ ...thread.executionActivity, room: thread.executionActivity });
  f.statusUnavailable(true);
  await restarted.tick();
  const failed = await directoryRoom(restarted);
  expect(failed).toMatchObject({ activity: "status_error", error: "Room owner status retrieval failed: HTTP 503", activeTools: [] });
  expect(failed.activitySince).toBeUndefined(); expect(failed.lastActivityAt).toBeUndefined();
  thread.state = "idle"; thread.held = true; thread.metadata.executionError = "Room execution failed";
  f.statusUnavailable(false);
  expect(await directoryRoom(restarted)).toMatchObject({ state: "idle", activity: "idle", held: true, error: "Room execution failed", activeTools: [] });
  const calls = f.calls.length;
  expect((await (await restarted.handle(request("/v1/rooms"), "cara")).json()).rooms).toEqual([]);
  expect(f.calls.length).toBe(calls);
});

test("owner status transport exceptions do not leave persisted running activity in a restarted directory", async () => {
  const f = fixture(); await f.create();
  f.threads.get(f.id).state = "running";
  f.threads.get(f.id).executionActivity = { activity: "thinking", activitySince: 10, lastActivityAt: 20, activeTools: [] };
  await f.rooms.tick();
  const restarted = new Rooms(f.path, () => people, async () => { throw new Error("Private transport diagnostic"); }); cleanup.push(() => restarted.close());
  const room = await directoryRoom(restarted);
  expect(room).toMatchObject({ state: "running", activity: "status_error", error: "Room owner status retrieval failed", activeTools: [] });
  expect(JSON.stringify(room)).not.toContain("Private transport diagnostic");
});

test("room owner rereads lifecycle after awaited history inspection", async () => {
  const id = crypto.randomUUID();
  let thread: any = { id, title: "House", state: "running", executionActivity: { activity: "thinking", activeTools: [] }, metadata: { room: { id, members: people.slice(0, 2) } } };
  const response = await handleRoomOwner(request(`/v1/room-owner/${id}`), {
    get: () => thread, create: async () => {}, update: async () => {}, send: async () => {}, notify: () => {},
    history: async () => { thread = { ...thread, state: "idle", held: true }; return { messages: [], live: "" }; },
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
