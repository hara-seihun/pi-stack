import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rooms } from "./rooms";
import { oneKenanEnabled as roomsEnabled } from "kenan-memory/config";
import { handleRoomOwner, publicRoomSnapshot } from "./rooms-owner";
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
  let unavailable = false;
  const transport = async (owner: string, actor: string, path: string, method: string, body?: unknown) => {
    if (unavailable && path.endsWith("/notify")) return Response.json({}, { status: 503 });
    return handleRoomOwner(request(path, method, body, actor), {
      get: id => threads.get(id) ?? null,
      create: async (id, title, members) => { threads.set(id, { id, title, state: "idle", metadata: { room: { id, members } } }); history.set(id, []); },
      update: async (id, members) => { threads.get(id).metadata.room.members = members; },
      send: async (id, receipt, text) => { inputs.push({ owner, actor, text }); history.get(id)!.push({ role: "user", timestamp: 10, content: text }); },
      history: async id => ({ messages: history.get(id) ?? [], live: "" }),
      notify: (id, receipt) => { const set = notices.get(owner) ?? new Set(); set.add(receipt); notices.set(owner, set); },
    });
  };
  const rooms = new Rooms(path, () => people, transport); cleanup.push(() => rooms.close());
  const id = crypto.randomUUID();
  const create = () => rooms.handle(request("/v1/rooms", "POST", { requestId: id, title: "House", members: ["bob"] }), "alice");
  return { rooms, id, create, path, threads, history, notices, inputs, transport, unavailable: (value: boolean) => { unavailable = value; } };
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
  expect(alice.rooms).toEqual(bob.rooms); expect(cara.rooms).toEqual([]);
  expect((await f.rooms.handle(request(`/v1/rooms/${f.id}`), "cara")).status).toBe(404);
  expect((await f.rooms.handle(request(`/v1/rooms/${f.id}/prompt`, "POST", { requestId: crypto.randomUUID(), text: "Hello", sender: "alice", owner: "cara" }), "bob")).status).toBe(202);
  expect(f.inputs[0]).toMatchObject({ owner: "alice", actor: "bob" });
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

test("the public room projection contains utterances, never thinking, tool bodies, private custom messages or raw context", () => {
  const id = crypto.randomUUID();
  const snapshot = publicRoomSnapshot({ id, title: "House", state: "idle", metadata: { room: { id, members: people.slice(0, 2) } } }, { live: "Public live text", messages: [
    { role: "user", timestamp: 1, content: roomInput(people[1]!, "Visible input") },
    { role: "user", timestamp: 2, content: "<agent_message>private worker details</agent_message>" },
    { role: "custom", content: "private custom message" },
    { role: "toolResult", content: [{ type: "text", text: "a private file" }] },
    { role: "assistant", timestamp: 3, content: [{ type: "thinking", thinking: "Alice's private medical record" }, { type: "toolCall", name: "read", arguments: { path: "/secret" } }, { type: "text", text: "Visible answer", textSignature: "hidden-provider-field" }] },
  ] });
  expect(snapshot.messages.map(message => message.text)).toEqual(["Visible input", "Visible answer"]);
  const encoded = JSON.stringify(snapshot); expect(encoded).not.toContain("private"); expect(encoded).not.toContain("/secret"); expect(encoded).not.toContain("hidden-provider-field");
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
