import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/store.js";
import { LifeStore } from "../src/life-store.js";
import { conservativeLifePolicy } from "../src/life-policy.js";
import { validateLifeRequest } from "../src/life-validation.js";
import { lifeClient } from "../src/life-client.js";
import { memoryService } from "../src/service.js";
import { MEMORY_TOKEN_HEADER } from "../src/contract.js";
import type { LifeEntity, LifeEntityInput, LifePolicyView, LifeProvenance, LifeRequest, LifeSnapshot } from "../src/life-contract.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const actor = { person: "alice", threadId: "thread" };
const target = { scope: "self" } as const;
const at = "2026-10-01T00:00:00.000Z";
const provenance = (): LifeProvenance => ({ factClass: "stated" as const, confidence: null, source: { actor: "alice", locator: null, observedAt: at }, evidence: [], counterevidence: [], validFrom: null, validUntil: null });
const commitment = (): LifeEntityInput => ({ kind: "commitment", title: "Example obligation", provenance: provenance(), state: "proposed", parties: ["alice"], authority: null, origin: "Explicit example", due: null, acceptance: "Delivery acknowledged", dependencies: [], owner: { kind: "kenan" }, nextAction: null, waiting: null, goalId: null });
const preference = (): LifeEntityInput => ({ kind: "preference", title: "Example preference", provenance: provenance(), context: "Example context", claim: "Example claim", options: [], constraints: [], agentExposure: null, adoptedRule: false });
function stores() { const memory = new MemoryStore(":memory:"); cleanup.push(() => memory.close()); return { memory, life: new LifeStore(memory.db) }; }
function value<T>(result: { ok: true; value: unknown } | { ok: false }): T { expect(result.ok).toBe(true); if (!result.ok) throw new Error("Expected success"); return result.value as T; }
async function http() {
  const { memory, life } = stores();
  const service = memoryService({ store: memory, enabled: () => true, peerUid: () => undefined, auth: { supervisors: [{ person: "alice", token: "alice-supervisor" }, { person: "bob", token: "bob-supervisor" }], publisherToken: "publisher", rootToken: "root-service" }, roomAudience: (_person, thread) => thread === "room" ? { roomId: "room-id", people: ["alice", "bob"] } : undefined });
  await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => service.close(() => resolve())));
  const url = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
  const post = async (token: string, request: unknown, path = "/v1/life") => {
    const response = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", [MEMORY_TOKEN_HEADER]: token }, body: JSON.stringify(request) });
    return { status: response.status, body: await response.json() as any };
  };
  return { memory, life, url, post };
}

test("life rows and IDs are encrypted under distinct subject keys, survive restart, and reject transplanted ciphertext", () => {
  const root = mkdtempSync(join(tmpdir(), "life-store-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "memory.sqlite3"); let memory = new MemoryStore(path), life = new LifeStore(memory.db);
  const secret = "Private example outcome";
  for (const subject of ["alice", "bob"]) value(life.request(subject, actor, { operation: "put-entity", target, id: "private-source-id", expectedRevision: 0, entity: { ...commitment(), title: secret } }));
  const rows = memory.db.query("SELECT subject,record,payload FROM life_versions").all() as { subject: string; record: string; payload: string }[];
  expect(rows).toHaveLength(2); expect(rows[0].payload).not.toBe(rows[1].payload); expect(rows[0].record).not.toBe(rows[1].record);
  for (const row of rows) { expect(row.payload).not.toContain(secret); expect(row.record).not.toContain("private-source-id"); }
  const keys = memory.db.query("SELECT key FROM life_keys").all() as { key: Uint8Array }[];
  expect(Buffer.from(keys[0].key).equals(Buffer.from(keys[1].key))).toBe(false);
  memory.close(); memory = new MemoryStore(path); life = new LifeStore(memory.db); cleanup.push(() => memory.close());
  expect(value<LifeSnapshot>(life.request("alice", actor, { operation: "read", target })).entities[0].value.title).toBe(secret);
  const alice = rows.find(row => row.subject === "alice")!;
  memory.db.query("UPDATE life_versions SET payload=? WHERE subject='bob'").run(alice.payload);
  expect(life.request("bob", actor, { operation: "read", target })).toMatchObject({ ok: false, error: "unavailable" });
});

test("entity CAS, kind stability, supersession, retraction and dependency cycles are conserved", () => {
  const { life } = stores();
  const write = (id: string, expectedRevision: number, entity: LifeEntityInput) => life.request("alice", actor, { operation: "put-entity", target, id, expectedRevision, entity });
  value(write("a", 0, commitment())); value(write("b", 0, commitment()));
  expect(write("a", 0, commitment())).toMatchObject({ ok: false, error: "conflict", currentRevision: 1 });
  expect(write("a", 1, preference())).toMatchObject({ ok: false, error: "invalid-request" });
  const a = commitment(); if (a.kind !== "commitment") throw new Error("Test kind"); a.dependencies = ["b"];
  value(write("a", 1, a));
  const b = commitment(); if (b.kind !== "commitment") throw new Error("Test kind"); b.dependencies = ["a"];
  expect(write("b", 1, b)).toMatchObject({ ok: false, error: "invalid-request" });
  const history = value<LifeEntity[]>(life.request("alice", actor, { operation: "entity-history", target, id: "a" }));
  expect(history.map(item => [item.revision, item.status, item.supersededBy])).toEqual([[2, "current", null], [1, "superseded", 2]]);
  value(life.request("alice", actor, { operation: "retract-entity", target, id: "a", expectedRevision: 2, reason: "Corrected source" }));
  expect(value<LifeSnapshot>(life.request("alice", actor, { operation: "read", target })).entities.map(item => item.id)).toEqual(["b"]);
});

test("boundary rejects unknown fields, impossible dates, missing unknowns, inference grants and fictional coverage", () => {
  const entity = commitment(); if (entity.kind !== "commitment") throw new Error("Test kind");
  const request = { operation: "put-entity", target, id: "a", expectedRevision: 0, entity };
  const valid = (input: unknown) => validateLifeRequest(input).ok;
  expect(valid(request)).toBe(true);
  expect(valid({ ...request, owner: "bob" })).toBe(false);
  for (const at of ["2026-02-30T00:00:00Z", "2026-10-01T24:00:00Z"]) expect(valid({ ...request, entity: { ...entity, due: { at, timeZone: "UTC" } } })).toBe(false);
  expect(valid({ ...request, entity: { ...entity, due: { at, timeZone: "Unknown/Place" } } })).toBe(false);
  expect(valid({ ...request, entity: { ...entity, title: "2026-10-01T00:00:00Z send report" } })).toBe(true);
  expect(valid({ ...request, entity: { ...entity, state: "waiting", waiting: null } })).toBe(false);
  const { due: _due, ...missingDue } = entity;
  expect(valid({ ...request, entity: missingDue })).toBe(false);
  const { life } = stores();
  expect(life.request("alice", actor, { operation: "policy-write", target, expectedRevision: 0, policy: conservativeLifePolicy("alice", at) })).toMatchObject({ ok: false, error: "invalid-request" });
  expect(valid({ operation: "coverage-write", target, expectedRevision: 0, coverage: { source: "calendar", state: "complete", checkedAt: at, reconciledAt: null, freshUntil: null, detail: null, error: null, evidence: [] } })).toBe(false);
});

test("one-time import is atomic, marker-first, and cannot reopen retracted commitments; reads do not reconcile", () => {
  const { life } = stores();
  const request: LifeRequest = { operation: "import-entities", target, source: "/example/todos.md", fingerprint: "a".repeat(64), entries: [{ id: "a", entity: commitment() }] };
  value(life.request("alice", actor, { operation: "put-entity", target, id: "collision", expectedRevision: 0, entity: commitment() }));
  expect(life.request("alice", actor, { ...request, entries: [...request.entries, { id: "collision", entity: commitment() }] })).toMatchObject({ ok: false, error: "conflict" });
  expect(value<LifeEntity[]>(life.request("alice", actor, { operation: "entity-history", target, id: "a" }))).toEqual([]);
  value(life.request("alice", actor, request));
  value(life.request("alice", actor, { operation: "retract-entity", target, id: "a", expectedRevision: 1, reason: "No longer current" }));
  expect(life.request("alice", actor, { ...request, fingerprint: "b".repeat(64), entries: [{ id: "collision", entity: commitment() }] })).toMatchObject({ ok: true, value: { fingerprint: "a".repeat(64), status: "already-imported" } });
  expect(value<LifeSnapshot>(life.request("alice", actor, { operation: "read", target })).coverage).toEqual([]);
  expect(life.request("alice", actor, { ...request, source: "/example/empty.md", entries: [] })).toMatchObject({ ok: true, value: { ids: [] } });
});

test("steering effect receipts survive revocation but new effects cannot borrow old authority", () => {
  const { life } = stores();
  const policy = { ...conservativeLifePolicy("alice", at), steering: { mode: "silent-permitted" as const, instruction: "Example grant" }, provenance: provenance() };
  value(life.request("alice", actor, { operation: "policy-write", target, expectedRevision: 0, policy }));
  value(life.request("alice", actor, { operation: "put-entity", target, id: "preference", expectedRevision: 0, entity: preference() }));
  const steering = { policyRevision: 1, goalIds: [], preferenceIds: ["preference"], evidence: [], action: "Example effect", rationale: "Example rationale", visibility: "silent" as const, state: "executing" as const, outcome: null, receipt: null, compensation: null };
  value(life.request("alice", actor, { operation: "steering-write", target, id: "effect", expectedRevision: 0, steering }));
  value(life.request("alice", actor, { operation: "retract-entity", target, id: "preference", expectedRevision: 1, reason: "Supporting observation corrected during the effect" }));
  value(life.request("alice", actor, { operation: "policy-write", target, expectedRevision: 1, policy: { ...policy, status: "revoked" } }));
  expect(life.request("alice", actor, { operation: "steering-write", target, id: "new", expectedRevision: 0, steering })).toMatchObject({ ok: false, error: "invalid-request" });
  expect(life.request("alice", actor, { operation: "steering-write", target, id: "effect", expectedRevision: 1, steering: { ...steering, state: "succeeded", outcome: "Receipt received", receipt: { kind: "receipt", id: "receipt1", relation: null } } })).toMatchObject({ ok: true, value: { revision: 2, value: { policyRevision: 1, state: "succeeded" } } });
  expect(value<LifePolicyView>(life.request("alice", actor, { operation: "policy-read", target, includeHistory: true })).history).toHaveLength(2);
});

test("authenticated life scope excludes ordinary rooms/publisher/root service and conservatively accounts private root reads", async () => {
  const { post, memory, url } = await http();
  const own = memory.session("alice", "person");
  const client = lifeClient({ url, token: own.token });
  const policy = value<LifePolicyView>(await client.request({ operation: "policy-read", target, includeHistory: true }));
  expect(policy.current?.value.steering.mode).toBe("off"); expect(policy.current?.revision).toBe(1);
  for (const token of [own.token, "publisher", "root-service", "unknown"]) {
    const denied = await post(token, { operation: "read", target: { scope: "person", person: "bob" } });
    expect(denied.status).toBe(403);
  }
  const room = memory.session("alice", "room");
  expect((await post(room.token, { operation: "policy-read", target, includeHistory: false })).status).toBe(403);
  const root = memory.admitRoot("pi-rooms", "room", ["alice", "bob"], [], "room-id");
  expect((await post(root.memoryToken, { operation: "read", target })).status).toBe(400);
  expect((await post(root.memoryToken, { operation: "policy-read", target: { scope: "person", person: "bob" }, includeHistory: false })).status).toBe(200);
  const rootOwn = await post(root.memoryToken, { operation: "policy-read", target: { scope: "root" }, includeHistory: false });
  expect(rootOwn.body.value).toMatchObject({ subject: "root:kenan", current: null });
  const final = memory.finalizeRootReply({ rootSessionId: root.rootSessionId, reply: "Example chosen reply", subjects: [] });
  expect(value<{ about: string[] }>(final).about).toContain("bob");
});

test("forget invalidates direct and transitive inference, preserves unrelated stated rows, and expiry removes preference projections", async () => {
  const { memory, life, post } = await http();
  const source = memory.write("alice", { text: "Example source", about: ["alice"], source: {}, setting: { person: "alice" }, obviouslyPrivate: false });
  const derived = preference(); derived.provenance = { ...provenance(), factClass: "derived", evidence: [{ kind: "memory", id: source.id, relation: null }] };
  value(life.request("alice", actor, { operation: "put-entity", target, id: "derived", expectedRevision: 0, entity: derived }));
  const dependent = preference(); dependent.provenance = { ...provenance(), factClass: "hypothesis", evidence: [{ kind: "life", id: "derived", relation: null }] };
  value(life.request("alice", actor, { operation: "put-entity", target, id: "dependent", expectedRevision: 0, entity: dependent }));
  value(life.request("alice", actor, { operation: "put-entity", target, id: "stated", expectedRevision: 0, entity: preference() }));
  const expired = preference(); expired.provenance.validUntil = at;
  value(life.request("alice", actor, { operation: "put-entity", target, id: "expired", expectedRevision: 0, entity: expired }));
  const session = memory.session("alice", "thread");
  expect((await post(session.token, { operation: "forget", ids: [source.id], mode: "stop-using" }, "/v1/memory")).status).toBe(200);
  const snapshot = value<LifeSnapshot>(life.request("alice", actor, { operation: "read", target }));
  expect(snapshot.entities.map(entity => entity.id)).toEqual(["stated"]);
  expect(value<LifeEntity[]>(life.request("alice", actor, { operation: "entity-history", target, id: "derived" }))[0].retractionReason).toContain("Supporting memory");
});

test("life client rejects malformed success payloads rather than presenting empty/current invented state", async () => {
  const client = lifeClient({ token: null, fetch: async () => new Response(JSON.stringify({ ok: true, value: { subject: "alice", entities: [] } })) });
  expect(await client.request({ operation: "read", target })).toMatchObject({ ok: false, error: "unavailable" });
});
