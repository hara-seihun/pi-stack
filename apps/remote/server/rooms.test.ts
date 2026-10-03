import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rooms } from "./rooms";
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
  const transport = async (owner: string, actor: string, path: string, method: string, body?: unknown) => {
    calls.push({ path, method });
    if (unavailable && path.endsWith("/notify")) return Response.json({}, { status: 503 });
    return handleRoomOwner(request(path, method, body, actor), {
      get: id => threads.get(id) ?? null,
      create: async (id, title, members) => { threads.set(id, { id, title, state: "idle", metadata: { room: { id, members } } }); history.set(id, []); },
      update: async (id, members) => { threads.get(id).metadata.room.members = members; },
      send: async (id, receipt, text) => { inputs.push({ owner, actor, text }); history.get(id)!.push({ role: "user", timestamp: 10, content: text }); },
      history: async id => ({ messages: history.get(id) ?? [], questions: questions.get(id) ?? [], live: "" }),
      stop: async id => { threads.get(id).state = "idle"; },
      answer: async (id, questionId) => { questions.set(id, (questions.get(id) ?? []).filter(question => question.id !== questionId)); threads.get(id).state = "running"; },
      notify: (id, receipt) => { const set = notices.get(owner) ?? new Set(); set.add(receipt); notices.set(owner, set); },
    });
  };
  const rooms = new Rooms(path, () => people, transport); cleanup.push(() => rooms.close());
  const id = crypto.randomUUID();
  const create = () => rooms.handle(request("/v1/rooms", "POST", { requestId: id, title: "House", members: ["bob"] }), "alice");
  return { rooms, id, create, path, threads, history, questions, calls, notices, inputs, transport, unavailable: (value: boolean) => { unavailable = value; } };
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
  const calls = f.calls.length;
  for (const actor of ["alice", "bob"]) {
    expect((await f.rooms.handle(request(`/v1/rooms/${f.id}/close`, "POST", {}), actor)).status).toBe(200);
    expect((await directoryRoom(f.rooms, actor)).current).toBe(false);
  }
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
