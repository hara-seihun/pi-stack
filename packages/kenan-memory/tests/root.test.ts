import { test, expect } from "bun:test";
import { MemoryStore } from "../src/store.js";
import { memoryService } from "../src/service.js";
import { memoryClient } from "../src/client.js";
import type { Disclosure, MemoryItem, MemoryRead, RootAdmission } from "../src/contract.js";

test("ranked retrieval tolerates extra natural words and stem/diacritic variations", () => {
  const store = new MemoryStore(":memory:");
  try {
    store.write("alice", { text: "Kenan emailed Gaétane about the foundation schedule. He sent the drawings.", about: ["alice", "bob"], source: { actedFor: "alice", action: "email" }, setting: { person: "alice" }, obviouslyPrivate: false });
    const found = store.search("bob", { threadId: "b", turnId: "t" }, "email Gaetane foundation schedule sent message");
    expect(found.value).toHaveLength(1);
    expect(store.search("bob", { threadId: "b", turnId: "t" }, "missing-word").value).toHaveLength(0);
  } finally { store.close(); }
});

test("person never reads shared/private facts; only own records and nonintimate affected actions", () => {
  const store = new MemoryStore(":memory:"); const context = { threadId: "b", turnId: "t" };
  try {
    const write = (text: string, about: string[], actor: string, action?: string, privateItem = false) => store.write(actor, { text, about, source: { actedFor: actor, ...(action ? { action } : {}) }, setting: { person: actor }, obviouslyPrivate: privateItem }) as MemoryItem;
    write("Alice intimate information", ["alice"], "alice");
    write("Mixed ordinary fact", ["alice", "bob"], "alice");
    write("Own Bob fact", ["bob"], "bob");
    write("Action relevant to Bob", ["alice", "bob"], "alice", "email");
    const privateAction = write("Mixed intimate action", ["alice", "bob"], "alice", "calendar", true);
    expect(store.search("bob", context, "", undefined, 20, "person").value.map(item => item.text).sort()).toEqual(["Action relevant to Bob", "Own Bob fact"]);
    expect(store.read("bob", context, [privateAction.id], "person").value).toEqual([]);
    expect(store.canForget("bob", [privateAction.id])).toBe(false);
    expect(store.search("bob", context, "", undefined, 20, "root").value).toHaveLength(5);
  } finally { store.close(); }
});

test("root admission is server-authenticated and exact reply committed before ack, even no-read refusal", async () => {
  const store = new MemoryStore(":memory:");
  const alice = store.session("alice", "a");
  const bob = store.session("bob", "b");
  let roomPeople = ["alice", "bob"];
  const server = memoryService({ store, auth: { supervisors: [{ person: "alice", token: "alice-supervisor" }, { person: "bob", token: "bob-supervisor" }], rootToken: "root-service" }, enabled: () => true, peerUid: () => undefined,
    roomAudience: (person, threadId) => person === "pi-rooms" && threadId === "room" ? { roomId: "room", people: roomPeople } : undefined });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (route: string, token: string, body: unknown): Promise<any> => fetch(url + route, { method: "POST", headers: { "x-kenan-memory-session": token }, body: JSON.stringify(body) }).then(r => r.json());
  try {
    expect(await post("/v1/root/admit", bob.token, { callerToken: alice.token, request: "health" })).toMatchObject({ ok: false, error: "unauthenticated" });
    expect(await post("/v1/sessions", "bob-supervisor", { threadId: "b", role: "root" })).toMatchObject({ ok: false });
    expect(await post("/v1/root/admit", "root-service", { callerToken: bob.token, person: "alice", request: "health" })).toMatchObject({ ok: false });
    const admission = (await post("/v1/root/admit", "root-service", { callerToken: bob.token, request: "What about Alice's health?" })).value as RootAdmission;
    expect(admission.person).toBe("bob"); expect(admission.recipients).toEqual(["bob"]); expect(admission.subjects).toContain("alice");
    expect(store.resolveSession(admission.memoryToken)?.role).toBe("root");
    const finalized = await post("/v1/root/finalize-reply", "root-service", { rootSessionId: admission.rootSessionId, reply: "I can't say either way", subjects: [] });
    expect(finalized.ok).toBe(true);
    expect(finalized.value).toMatchObject({ kind: "root-reply", text: "I can't say either way", to: ["bob"] });
    expect(finalized.value.about).toContain("alice");
    expect(store.resolveSession(admission.memoryToken)).toBeUndefined();
    const logs = store.disclosures("alice", { threadId: "a", turnId: "log" }, 100, "root").value;
    expect(logs.some(log => log.kind === "root-reply" && log.text === "I can't say either way")).toBe(true);
    expect(store.disclosures("bob", { threadId: "b", turnId: "log" }, 100, "person").value.some(log => log.rootSessionId === admission.rootSessionId)).toBe(false);
    expect((await post("/v1/root/finalize-reply", "root-service", { rootSessionId: admission.rootSessionId, reply: "Different", subjects: [] })).ok).toBe(false);
    const room = store.session("pi-rooms", "room");
    const roomAdmission = (await post("/v1/root/admit", "root-service", { callerToken: room.token, request: "Question for Alice" })).value as RootAdmission;
    expect(roomAdmission.recipients).toEqual(["alice", "bob"]);
    expect((await post("/v1/root/finalize-reply", "root-service", { rootSessionId: roomAdmission.rootSessionId, reply: "Only Alice", subjects: [], recipients: ["alice"] })).ok).toBe(false);
    roomPeople = ["alice", "bob", "carol"];
    expect((await post("/v1/root/finalize-reply", "root-service", { rootSessionId: roomAdmission.rootSessionId, reply: "Audience changed", subjects: [] })).ok).toBe(false);
    const ownClient = memoryClient({ url, token: bob.token });
    expect((await ownClient.request({ operation: "search", query: "", about: ["alice"], context: { threadId: "b", turnId: "t" } })).ok).toBe(false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});

test("boundary finalization unions root read subjects without model log calls", () => {
  const store = new MemoryStore(":memory:");
  try {
    const item = store.write("carol", { text: "Private info", about: ["carol"], source: { saidBy: "carol" }, setting: { person: "carol" }, obviouslyPrivate: true }) as MemoryItem;
    const admission = store.admitRoot("bob", "b", ["bob"], ["alice"]);
    store.read("bob", { threadId: admission.rootSessionId, turnId: "t" }, [item.id], "root");
    const result = store.finalizeRootReply({ rootSessionId: admission.rootSessionId, reply: "I can't say either way", subjects: [] });
    expect(result.ok && result.value.about.sort()).toEqual(["alice", "bob", "carol"]);
  } finally { store.close(); }
});
