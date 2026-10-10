import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "../src/store.js";
import { memoryService } from "../src/service.js";
import { kenanRequestNotice } from "../src/contract.js";

async function fixture() {
  const store = new MemoryStore(":memory:");
  let audience = { roomId: "fixture-room", people: ["alice", "bob"] };
  const server = memoryService({ store, enabled: () => true, peerUid: () => undefined,
    auth: { rootToken: "fixture-service", supervisors: [{ person: "alice", token: "fixture-alice" }, { person: "bob", token: "fixture-bob" }] },
    roomAudience: (person, thread) => person === "pi-rooms" && thread === "room-thread" ? audience : undefined });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (route: string, body: unknown, token = "fixture-service") => {
    const response = await fetch(url + route, { method: "POST", headers: { "x-kenan-memory-session": token }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  return { store, post, audience: (value: typeof audience) => audience = value,
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); } };
}

test("absence recovery authenticates a person capability without admitting root work", async () => {
  const f = await fixture();
  try {
    const caller = f.store.session("alice", "original-thread");
    const check = (callerToken: string, token?: string) => f.post("/v1/root/authenticate-caller", { callerToken }, token);
    expect((await check(caller.token)).body).toEqual({ ok: true, value: { authenticated: true } });
    expect((await check("missing")).status).toBe(403);
    expect((await check(caller.token, caller.token)).status).toBe(403);
    expect((await check("fixture-service")).status).toBe(403);
    expect((await f.post("/v1/root/authenticate-caller", { callerToken: caller.token, person: "bob" })).status).toBe(400);
    expect(f.store.db.query("SELECT count(*) AS count FROM root_runs").get()).toEqual({ count: 0 });
  } finally { await f.close(); }
});

test("request authorization binds verified person/thread, accepts renewed capabilities, and never creates a root model admission", async () => {
  const f = await fixture();
  try {
    const caller = f.store.session("alice", "original-thread"), otherThread = f.store.session("alice", "other-thread"), otherPerson = f.store.session("bob", "original-thread");
    const root = f.store.admitRoot("alice", "original-thread", ["alice"], ["bob"]);
    const check = (token: string) => f.post("/v1/root/authorize-request", { callerToken: token, rootSessionId: root.rootSessionId });
    expect((await check(caller.token)).body).toEqual({ ok: true, value: { authorized: true } });
    expect((await check(otherThread.token)).status).toBe(403);
    expect((await check(otherPerson.token)).status).toBe(403);
    expect((await check(root.memoryToken)).status).toBe(403);
    expect((await f.post("/v1/root/authorize-request", { callerToken: caller.token, rootSessionId: root.rootSessionId }, caller.token)).status).toBe(403);
    f.store.finalizeRootReply({ rootSessionId: root.rootSessionId, reply: "Chosen", subjects: [] });
    const renewed = f.store.session("alice", "original-thread");
    expect((await check(renewed.token)).body).toEqual({ ok: true, value: { authorized: true } });
    expect(f.store.db.query("SELECT count(*) AS count FROM root_runs").get()).toEqual({ count: 1 });
  } finally { await f.close(); }
});

test("request lookup, chosen delivery retries and generic terminal notices recheck the current entire room", async () => {
  const f = await fixture();
  try {
    const room = f.store.session("pi-rooms", "room-thread");
    const root = (await f.post("/v1/root/admit", { callerToken: room.token, request: "fixture question" })).body.value;
    const lookup = () => f.post("/v1/root/authorize-request", { callerToken: room.token, rootSessionId: root.rootSessionId });
    const finalize = () => f.post("/v1/root/finalize-reply", { rootSessionId: root.rootSessionId, reply: "Chosen", subjects: [] });
    const notice = { rootSessionId: root.rootSessionId, requestId: randomUUID(), status: "interrupted" };
    expect((await lookup()).status).toBe(200); expect((await finalize()).status).toBe(200);
    f.audience({ roomId: "fixture-room", people: ["alice", "bob", "carol"] });
    expect((await lookup()).status).toBe(403); expect((await finalize()).status).toBe(403);
    expect((await f.post("/v1/root/log-request-status", notice)).status).toBe(403);
    f.audience({ roomId: "another-room", people: ["alice", "bob"] });
    expect((await lookup()).status).toBe(403); expect((await finalize()).status).toBe(403);
    f.audience({ roomId: "fixture-room", people: ["bob", "alice"] });
    expect((await lookup()).status).toBe(200); expect((await finalize()).status).toBe(200);
    const recorded = await f.post("/v1/root/log-request-status", notice);
    expect(recorded.body.ok).toBe(true);
    expect((await f.post("/v1/root/log-request-status", notice)).body).toEqual(recorded.body);
    expect((await f.post("/v1/root/log-request-status", { ...notice, text: "private error" })).status).toBe(400);
    const logs = f.store.disclosures("pi-rooms", { threadId: "fixture", turnId: "log" }, 100, "root").value;
    expect(logs.find(log => log.kind === "root-request-status")?.text).toBe(kenanRequestNotice(notice.requestId, "interrupted"));
  } finally { await f.close(); }
});

test("queued admission recovery belongs only to root service, preserves identity, and refuses changed audience or retired tokens", async () => {
  const f = await fixture();
  try {
    const person = f.store.session("alice", "original-thread"), root = f.store.admitRoot("alice", "original-thread", ["alice"], ["bob"]);
    const input = { rootSessionId: root.rootSessionId };
    expect((await f.post("/v1/root/resume-request", input, person.token)).status).toBe(403);
    expect((await f.post("/v1/root/resume-request", input, root.memoryToken)).status).toBe(403);
    expect((await f.post("/v1/root/resume-request", { ...input, person: "bob" })).status).toBe(400);
    expect((await f.post("/v1/root/resume-request", input)).body).toEqual({ ok: true, value: root });
    expect(f.store.db.query("SELECT count(*) AS count FROM root_runs").get()).toEqual({ count: 1 });
    f.store.finalizeRootReply({ rootSessionId: root.rootSessionId, reply: "Chosen", subjects: [] });
    expect((await f.post("/v1/root/resume-request", input)).status).toBe(403);
    const room = f.store.admitRoot("pi-rooms", "room-thread", ["alice", "bob"], [], "fixture-room");
    expect((await f.post("/v1/root/resume-request", { rootSessionId: room.rootSessionId })).status).toBe(200);
    f.audience({ roomId: "fixture-room", people: ["alice", "bob", "carol"] });
    expect((await f.post("/v1/root/resume-request", { rootSessionId: room.rootSessionId })).status).toBe(403);
  } finally { await f.close(); }
});

test("root notification accounting is registered, private-aware, atomic and idempotent with exact chosen text", async () => {
  const f = await fixture();
  try {
    const root = f.store.admitRoot("alice", "original-thread", ["alice"], ["alice"]), caller = f.store.session("alice", "original-thread");
    const input = { rootSessionId: root.rootSessionId, notificationId: randomUUID(), recipient: "bob", text: "Chosen notification", subjects: ["alice", "bob"], obviouslyPrivate: false };
    const first = await f.post("/v1/root/log-notification", input);
    expect(first.body.ok).toBe(true);
    expect((await f.post("/v1/root/log-notification", input)).body).toEqual(first.body);
    expect((await f.post("/v1/root/log-notification", { ...input, text: "Changed notification" })).status).toBe(400);
    expect((await f.post("/v1/root/log-notification", { ...input, obviouslyPrivate: true })).status).toBe(400);
    expect((await f.post("/v1/root/log-notification", { ...input, recipient: "unknown" })).status).toBe(400);
    expect((await f.post("/v1/root/log-notification", { ...input, rootSessionId: "unknown" })).status).toBe(400);
    expect((await f.post("/v1/root/log-notification", input, caller.token)).status).toBe(403);
    const context = { threadId: "fixture-bob", turnId: "search" };
    const own = f.store.search("bob", context, "", undefined, 100, "person").value;
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ text: input.text, source: { actedFor: "alice", action: "notification-queued" } });
    await f.post("/v1/root/log-notification", { ...input, notificationId: randomUUID(), text: "Private chosen notification", obviouslyPrivate: true });
    expect(f.store.search("bob", context, "", undefined, 100, "person").value).toHaveLength(1);
    expect(f.store.db.query("SELECT count(*) AS count FROM disclosures WHERE json_extract(body,'$.kind')='root-notification'").get()).toEqual({ count: 2 });
    expect(f.store.search("bob", context, "", undefined, 100, "root").value).toHaveLength(2);
  } finally { await f.close(); }
});
