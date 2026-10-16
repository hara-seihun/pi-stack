import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/store.js";
import { memoryService } from "../src/service.js";
import { fixtureAuthorization } from "./authorization.js";
import { memoryClient } from "../src/client.js";
import { memoryExtension } from "../src/tools.js";
import { oneKenanEnabled } from "../src/config.js";
import { isPrivateMount } from "../src/private-store.js";
import { validateRequest } from "../src/validation.js";
import type { MemoryInput, MemoryItem, MemoryRead } from "../src/contract.js";
const item: MemoryInput = { text: "Kenan emailed the contractor", about: ["alice", "bob"], source: { actedFor: "alice", action: "email", externalId: "message-1" }, setting: { person: "alice", threadId: "a" }, obviouslyPrivate: false };
const context = { threadId: "b", turnId: "turn-1" };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function store() { const s = new MemoryStore(":memory:"); cleanups.push(() => s.close()); return s; }
describe("one shared memory", () => {
  test("another person recalls Kenan's action and reports cross-person reads", () => {
    const s = store(); const action = s.write("alice", item) as MemoryItem;
    const found = s.search("bob", context, "contractor");
    expect(found.value.map(i => i.id)).toEqual([action.id]);
    expect(found.readReport).toEqual({ ...context, person: "bob", about: ["alice", "bob"], touchedOtherPeople: true });
    expect(s.search("alice", context, "nothing").readReport.touchedOtherPeople).toBe(false);
    expect(s.search("alice", { ...context, roomId: "room" }, "nothing").readReport.touchedOtherPeople).toBe(true);
  });
  test("intimate memory remains available to Kenan's judgment, not a coded ACL", () => {
    const s = store(); s.write("alice", { ...item, text: "Private health information", about: ["alice"], source: { saidBy: "alice" }, obviouslyPrivate: true });
    const result = s.search("bob", context, "health");
    expect(result.value[0].obviouslyPrivate).toBe(true);
    expect(result.readReport.touchedOtherPeople).toBe(true);
  });
  test("stop-using and delete cannot be resurrected by action replay", () => {
    const s = store(); const action = s.write("alice", item) as MemoryItem;
    expect(s.write("alice", item)).toEqual(action);
    s.forget([action.id], "stop-using");
    expect(s.search("bob", context, "").value).toEqual([]);
    expect(s.read("bob", context, [action.id]).value).toEqual([]);
    expect(s.write("alice", item)).toEqual({ id: action.id, forgotten: true });
    s.forget([action.id], "delete");
    expect(s.db.query("SELECT body FROM memories WHERE id=?").get(action.id)).toBeNull();
    expect(s.write("alice", item)).toEqual({ id: action.id, forgotten: true });
  });
  test("session credentials and disclosure history survive restart", () => {
    const root = mkdtempSync(join(tmpdir(), "kenan-memory-test-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "memory.sqlite3"); let s = new MemoryStore(path);
    const session = s.session("alice", "a");
    s.disclose("bob", { text: "I emailed the contractor for Alice", about: ["alice"], to: ["bob"], setting: { person: "bob", threadId: "b" } });
    s.close(); s = new MemoryStore(path); cleanups.push(() => s.close());
    expect(s.resolveSession(session.token)).toEqual({ person: "alice", threadId: "a", role: "person" });
    expect(s.disclosures("alice", context).value[0].text).toBe("I emailed the contractor for Alice");
    expect(s.disclosures("bob", context).value).toEqual([]);
  });
  test("ambiguous forget and malformed provenance rejected with the specific reason", () => {
    expect(validateRequest({ operation: "forget", ids: ["x"] })).toEqual({ ok: false, reason: 'mode must be "delete" or "stop-using"' });
    for (const source of [{}, { action: "email", externalId: "message-1" }])
      expect(validateRequest({ operation: "write", item: { ...item, source } })).toEqual({ ok: false, reason: expect.stringContaining("source needs saidBy or actedFor") });
    expect(validateRequest({ operation: "write", item: { ...item, source: { saidBy: " " } } })).toEqual({ ok: false, reason: expect.stringContaining("source.saidBy must be a non-blank string") });
    expect(validateRequest({ operation: "write", item: { ...item, about: [] } })).toEqual({ ok: false, reason: "about must be a non-empty array of at most 100 non-blank strings" });
    expect(validateRequest({ operation: "write", item: { ...item, occurredAt: "yesterday-ish" } })).toEqual({ ok: false, reason: "occurredAt must be an ISO 8601 date-time string when present" });
    expect(validateRequest({ operation: "log-disclosure", disclosure: { text: "x", about: ["alice"], to: [], setting: item.setting } })).toEqual({ ok: false, reason: "to must be a non-empty array of at most 100 non-blank strings" });
  });
  test("an action record with actedFor validates unchanged", () => {
    expect(validateRequest({ operation: "write", item })).toEqual({ ok: true, request: { operation: "write", item } });
  });
});

test("HTTP session proves person; claimed names grant nothing; publisher writes only", async () => {
  const s = store(); let enabled = true;
  const server = memoryService({ authorize: fixtureAuthorization, store: s, auth: { supervisors: [{ person: "alice", token: "supervisor-alice" }], publisherToken: "publisher" }, enabled: () => enabled, peerUid: () => undefined });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const mint = await fetch(`${url}/v1/sessions`, { method: "POST", headers: { "x-kenan-memory-session": "supervisor-alice" }, body: JSON.stringify({ threadId: "a" }) }).then(r => r.json()) as any;
  expect(mint.value.person).toBe("alice");
  const client = memoryClient({ url, token: mint.value.token });
  expect((await client.request({ operation: "write", item: { ...item, setting: { person: "bob", threadId: "a" } } })).ok).toBe(false);
  expect((await client.request({ operation: "write", item })).ok).toBe(true);
  expect(await client.request({ operation: "write", item: { ...item, source: { action: "email", externalId: "message-2" } } as unknown as MemoryInput }))
    .toEqual({ ok: false, error: "invalid-request", message: expect.stringContaining("source needs saidBy or actedFor") });
  expect((await client.request({ operation: "search", query: "", context })).ok).toBe(false);
  expect((await memoryClient({ url }).request({ operation: "write", item })).ok).toBe(false);
  const publisher = memoryClient({ url, token: "publisher" });
  expect((await publisher.request({ operation: "search", query: "", context })).ok).toBe(false);
  expect((await publisher.request({ operation: "write", item: { ...item, setting: { person: "bob" } } })).ok).toBe(true);
  enabled = false;
  expect(await client.request({ operation: "write", item })).toMatchObject({ ok: false, error: "disabled" });
});

test("flag off registers no tools or guidance; ambiguous tool asks without changing memory", async () => {
  const root = mkdtempSync(join(tmpdir(), "kenan-flag-test-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "host.json"); writeFileSync(path, "{}");
  const env = { PI_STACK_HOST_CONFIG: path, PI_KENAN_MEMORY_PERSON: "alice", PI_THREAD_ID: "a", PI_KENAN_MEMORY_ROLE: "person", PI_KENAN_MEMORY_TOKEN: "fixture-session" };
  expect(oneKenanEnabled(env)).toBe(false);
  const tools: any[] = []; const handlers: any[] = [];
  let active = ["bash"];
  const api = { registerTool: (t: unknown) => tools.push(t), on: (...args: unknown[]) => handlers.push(args), getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; }, getAllTools: () => tools };
  let asked = 0; let requests = 0;
  const options = { env, client: { request: async () => { requests++; return { ok: false as const, error: "unavailable" as const, message: "test" }; } }, ask: async () => { asked++; return {}; } };
  memoryExtension(options)(api as any); expect(tools).toHaveLength(0);
  const before = handlers.find(h => h[0] === "before_agent_start")[1];
  expect(await before({ systemPrompt: "base" })).toBeUndefined();
  expect(active).toEqual(["bash"]);
  writeFileSync(path, JSON.stringify({ oneKenan: true }));
  const guidance = await before({ systemPrompt: "base" });
  expect(guidance.systemPrompt).toContain("transparent working context");
  expect(active).toContain("ask_kenan");
  const result = await tools.find(t => t.name === "memory_forget").execute("id", { ids: ["x"] });
  expect(result.details.clarificationRequired).toBe(true); expect(asked).toBe(1); expect(requests).toBe(0);
  writeFileSync(path, "{}");
  expect(await before({ systemPrompt: "base" })).toBeUndefined();
  expect(active).toEqual(["bash"]);
});
