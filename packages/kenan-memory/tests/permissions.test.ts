import { expect, test } from "bun:test";
import { memoryService } from "../src/service.js";
import { MemoryStore } from "../src/store.js";
import { fixtureAuthorization } from "./authorization.js";

test("authenticated journal credentials never bypass the unified grant decision", async () => {
  const store = new MemoryStore(":memory:");
  const server = memoryService({ store, enabled: () => true, auth: { supervisors: [{ person: "kenan", token: "credential" }] }, peerUid: () => undefined,
    authorize: () => ({ ok: false, error: { code: "denied", message: "No resource grant" } }) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/sessions`, { method: "POST", headers: { "x-kenan-memory-session": "credential", "content-type": "application/json" }, body: JSON.stringify({ threadId: "thread" }) });
    expect(response.status).toBe(403);
    expect(store.db.query("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});

test("a private consultation grant is filtered by actual records, not root role", async () => {
  const store = new MemoryStore(":memory:");
  const alice = store.write("alice", { text: "Alice fact", about: ["alice"], source: { saidBy: "alice" }, setting: { person: "alice", threadId: "source" }, obviouslyPrivate: true });
  const bob = store.write("bob", { text: "Bob private fact", about: ["bob"], source: { saidBy: "bob" }, setting: { person: "bob", threadId: "source" }, obviouslyPrivate: true });
  const admission = store.admitRoot("alice", "requester", ["alice"], []);
  const server = memoryService({ store, enabled: () => true, auth: { supervisors: [] }, peerUid: () => undefined,
    authorize: request => request.record?.about.some(subject => subject !== "alice") ? { ok: false, error: { code: "denied", message: "Only Alice records" } } : fixtureAuthorization(request) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const send = async (operation: unknown) => fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/memory`, { method: "POST", headers: { "x-kenan-memory-session": admission.memoryToken, "content-type": "application/json" }, body: JSON.stringify(operation) });
    const context = { threadId: admission.rootSessionId, turnId: "turn" };
    const found = await (await send({ operation: "search", query: "", context, limit: 1 })).json() as any;
    expect(found.value.value.map((item: any) => item.id)).toEqual([alice.id]);
    expect(found.value.readReport.about).toEqual(["alice"]);
    const read = await (await send({ operation: "read", ids: [bob.id], context })).json() as any;
    expect(read.value.value).toEqual([]);
    expect(read.value.readReport.about).toEqual([]);
    expect((await send({ operation: "forget", ids: [bob.id], mode: "delete" })).status).toBe(403);
    expect((await send({ operation: "forget", ids: ["absent-private-id"], mode: "delete" })).status).toBe(403);
    expect(store.authorizationItems([bob.id])).toHaveLength(1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
