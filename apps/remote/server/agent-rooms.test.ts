import { expect, test } from "bun:test";
import { userInfo, tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ActionJournal } from "kenan-memory/journal";
import { loopbackPeer } from "pi-orchestrator/api";
import { handleAgentRooms, roomPersonUids } from "./agent-rooms";
import { parseRoomArgs, runRoomCli, type RoomFetch } from "./room-cli";

test.skipIf(process.getuid?.() === 0)("real local socket binds rooms to the Unix person despite forged headers", async () => {
  const user = userInfo().username;
  const users = roomPersonUids([user]);
  expect(users.get(process.getuid!())).toBe(user);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req, server) {
    const socket = server.requestIP(req);
    const peer = socket ? loopbackPeer({ address: socket.address, port: socket.port, localAddress: "127.0.0.1", localPort: server.port! }, "/proc", false) : undefined;
    return handleAgentRooms(req, peer, users, { handle: async (forwarded, actor, kind) => Response.json({ actor, kind, path: new URL(forwarded.url).pathname, identityHeader: forwarded.headers.get("x-pi-remote-user") }) });
  } });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/agent-rooms?user=not-me`, { headers: { "x-pi-remote-user": "not-me", "x-pi-remote-session": "forged", "x-pi-thread-token": "forged" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ actor: user, kind: "agent", path: "/v1/rooms", identityHeader: null, person: user });
  } finally { server.stop(true); }
});

test("agent room reads preserve paging and fences without forwarding identity hints", async () => {
  const id = crypto.randomUUID();
  const response = await handleAgentRooms(new Request(`http://fixture/v1/agent-rooms/${id}?before=42&limit=12&revision=r1&user=forged`),
    { uid: 1001 }, new Map([[1001, "alice"]]), { handle: async (request, actor) => {
      expect(actor).toBe("alice");
      expect(new URL(request.url).pathname).toBe(`/v1/rooms/${id}`);
      expect(new URL(request.url).search).toBe("?before=42&limit=12&revision=r1");
      return Response.json({ error: "revision changed" }, { status: 409 });
    } });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "revision changed", person: "alice" });
});

test("UID person mapping refuses ambiguous users and never admits root", () => {
  expect([...roomPersonUids(["root", "missing", "alice"], name => ({ root: 0, alice: 1001 } as Record<string, number>)[name])]).toEqual([[1001, "alice"]]);
  expect(() => roomPersonUids(["alice", "bob"], () => 1001)).toThrow("distinct Unix identities");
});

test("CLI reports the page window, displayed subset and transparent page work", async () => {
  const values: any[] = [];
  const io = { out: (value: unknown) => values.push(value), error: (text: string) => { throw new Error(text); }, help: () => {} };
  const id = crypto.randomUUID();
  const paging = { revision: "room-r1", total: 102, start: 100, end: 102, hasOlder: true, nextBefore: 100 };
  const urls: string[] = [];
  const request: RoomFetch = async url => {
    urls.push(String(url));
    return Response.json({ messages: [{ text: "first" }, { text: "last" }], work: [{ text: "tools" }], thinking: "thinking", paging, state: "idle" });
  };
  expect(await runRoomCli(["read", id, "--last", "1"], io, request, {})).toBe(0);
  expect(values.pop()).toEqual({ state: "idle", paging, historyScope: "page", shownMessages: 1, pageMessages: 2, messages: [{ text: "last" }] });
  expect(await runRoomCli(["read", id, "--last", "0", "--work"], io, request, {})).toBe(0);
  expect(values.pop()).toMatchObject({ messages: [{ text: "first" }, { text: "last" }], paging, historyScope: "page", shownMessages: 2, work: [{ text: "tools" }], thinking: "thinking" });
  expect(await runRoomCli(["read", id, "--before", "100", "--revision", "room-r1", "--limit", "2"], io, request, {})).toBe(0);
  expect(urls.at(-1)).toContain("?before=100&revision=room-r1&limit=2");
  for (const argv of [["read", id, "--limit", "33"], ["read", id, "--before", "-1"], ["read", id, "--revision", ""], ["list", "--before", "1"]]) expect(parseRoomArgs(argv).ok).toBe(false);
});

test("CLI retains the actual generated send identity on a lost acknowledgement and never retries", async () => {
  const values: any[] = []; let requests = 0; let sent: any;
  const id = crypto.randomUUID();
  const journal = new ActionJournal({ enabled: () => false });
  const io = { out: (value: unknown) => values.push(value), error: () => {}, help: () => {} };
  const request: RoomFetch = async (url, options) => {
    expect(String(url)).toContain("/v1/agent-rooms/");
    if (!options?.body) return Response.json({ person: "alice", room: { id, members: [{ user: "alice", displayName: "Alice" }] } });
    requests++; sent = JSON.parse(String(options.body)); expect(options.headers).toEqual({ "content-type": "application/json" }); throw new Error("Acknowledgement lost");
  };
  expect(await runRoomCli(["send", id, "Hello"], io, request, { USER: "someone-else", PI_REMOTE_SESSION: "not-used" }, journal)).toBe(1);
  expect(requests).toBe(1);
  expect(values[0]).toMatchObject({ error: "unconfirmed", requestId: sent.requestId });
  expect(parseRoomArgs(["send", crypto.randomUUID(), "-", "--request-id", sent.requestId], () => "stdin message")).toMatchObject({ ok: true, value: { body: { requestId: sent.requestId, text: "stdin message" } } });
  expect(await runRoomCli(["send", crypto.randomUUID(), "Hello"], io, request, { PI_ROOM_URL: "http://remote.example" }, journal)).toBe(1);
  expect(requests).toBe(1);
});

test("room CLI journals verified membership and prevents posting when intent custody fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "room-cli-journal-"));
  const records: any[] = []; const output: any[] = []; let posts = 0;
  const io = { out: (value: unknown) => output.push(value), error: () => {}, help: () => {} };
  const id = crypto.randomUUID(); const members = [{ user: "alice", displayName: "Alice" }, { user: "bob", displayName: "Bob" }];
  const request: RoomFetch = async (url, options) => {
    if (!options?.body) return Response.json({ person: "bob", room: { id, members } });
    posts++; return Response.json({ accepted: true, room: { id, members } }, { status: 202 });
  };
  const journal = new ActionJournal({ enabled: () => true, directory: root, autoDrain: false,
    client: { request: async (request: any) => { records.push(request.item); return { ok: true, value: {} } as any; } } });
  try {
    expect(await runRoomCli(["send", id, "Hello"], io, request, { USER: "alice" }, journal)).toBe(0);
    expect((await journal.drain()).ok).toBe(true);
    expect(records.map(record => record.source.action).sort()).toEqual(["room.post:attempted", "room.post:confirmed"]);
    expect(records.every(record => record.source.actedFor === "bob" && record.about.includes("alice") && record.setting.roomId === id)).toBe(true);
    expect(await runRoomCli(["send", id, "Hello"], io, request, {}, { begin: () => { throw new Error("disk full"); }, finish: () => ({ ok: true }) })).toBe(1);
    expect(posts).toBe(1);
    expect(output.at(-1)).toMatchObject({ error: "transport", guidance: "Nothing was sent." });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
