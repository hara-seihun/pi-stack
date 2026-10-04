import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../kenan-memory/src/store";
import { memoryService } from "../../kenan-memory/src/service";
import { ThreadService, threadHttp, createThreadClient } from "pi-orchestrator/api";
import { rootConsentHandler } from "../../../apps/remote/server/root-consent";
import { RootConsentManager, createConsentBridge, rootMemoryRpc } from "../src/consent";
import { ROOT_CONSENT_HEADER } from "../src/consent-contract";
import type { Person } from "../../../apps/remote/server/persons";
import type { RootExecutor } from "../src/root-runtime";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "root-consent-"));
  const owners = Object.fromEntries(["alice", "bob"].map(person => [person, new ThreadService({ databasePath: join(root, `${person}.sqlite`), sessionsDir: join(root, person), openSession: async () => { throw Error("Fixture must not start a model"); } })]));
  await owners.bob.spawn({ id: "bob-thread", requestId: "bob-thread", cwd: root });
  const people = ["alice", "bob"].map((user, index): Person => ({ version: 1, user, displayName: user, port: 19001 + index, environment: { PI_REMOTE_PRIVATE_DIR: root, PI_REMOTE_PRIVATE_ID: user } }));
  const router = rootConsentHandler({ capability: () => "c".repeat(64), persons: () => people, client: person => createThreadClient("http://fixture/v1/threads", async (input, init) => (await threadHttp(owners[person], new Request(input, init)))!) });
  const bridge = createConsentBridge("http://127.0.0.1:19880", "c".repeat(64), (async (input, init) => (await router(new Request(input, init)))!) as typeof fetch);
  const store = new MemoryStore(join(root, "memory.sqlite"));
  const server = memoryService({ store, auth: { supervisors: people.map(person => ({ person: person.user, token: person.user + "-supervisor" })), rootToken: "root-service" }, enabled: () => true, peerUid: () => undefined });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const memory = rootMemoryRpc(`http://127.0.0.1:${(server.address() as { port: number }).port}`, "root-service");
  const admission = store.admitRoot("bob", "bob-thread", ["bob"], ["alice"]);
  const close = async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); for (const owner of Object.values(owners)) await owner.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, owners, people, router, bridge, store, memory, admission, close };
}

test.each([true, false])("Bob asks Alice, fresh root delivers once across restart/lost ACK (original finalized: %s)", async finalized => {
  const f = await fixture(); let manager: RootConsentManager | undefined;
  try {
    let judgments = 0, loseAck = true;
    const executor: RootExecutor = async (admission, request) => {
      judgments++; expect(admission.person).toBe("bob"); expect(admission.threadId).toBe("bob-thread");
      expect(admission.recipients).toEqual(["bob"]); expect(admission.rootSessionId).not.toBe(f.admission.rootSessionId);
      expect(request).toContain("Only the scheduling detail.");
      return { ok: true, value: { reply: "Alice can meet Tuesday at 14:00. Nothing else was authorized.", subjects: ["alice", "bob"] } };
    };
    const options = { memory: f.memory, enabled: () => true, executor, bridge: { ...f.bridge, reply: async (input: Parameters<typeof f.bridge.reply>[0]) => {
      const delivered = await f.bridge.reply(input);
      if (loseAck) { loseAck = false; return { ok: false as const, message: "Fixture lost the successful reply ACK" }; }
      return delivered;
    } } };
    const path = join(f.root, "consent.sqlite"); manager = new RootConsentManager(path, options);
    const asked = await manager.request(f.admission, "What is Alice's private scheduling detail?", { subject: "alice", question: "Bob asked when you can meet. May I share only your meeting time with Bob?" });
    expect(asked.ok).toBe(true);
    const threads = await f.owners.alice.list(); if (!threads.ok) throw Error("No subject inbox");
    expect(threads.value.threads).toHaveLength(1);
    const threadId = threads.value.threads[0].id;
    const questions = await f.owners.alice.questions(threadId); if (!questions.ok) throw Error("No question");
    expect(questions.value).toHaveLength(1); expect(questions.value[0].question).toContain("Authenticated requester: bob");
    expect(questions.value[0].question).toContain("Chosen answer would go to: bob");
    expect(f.owners.bob.pending("bob-thread")).toHaveLength(0);
    if (finalized) f.store.finalizeRootReply({ rootSessionId: f.admission.rootSessionId, reply: "I've asked Alice; I'll reply here when she answers.", subjects: ["alice"] });
    manager.close(); manager = new RootConsentManager(path, options);
    expect(await manager.drain()).toEqual({ pending: 1, delivered: 0, errors: 0 });
    const questionId = questions.value[0].id;
    expect(await f.owners.alice.answer({ threadId, questionId, selectedSuggestionIds: [`${questionId}:0`], text: "Only the scheduling detail." })).toMatchObject({ ok: true });
    expect(await manager.drain()).toEqual({ pending: 1, delivered: 0, errors: 1 });
    expect(judgments).toBe(1); expect(f.owners.bob.pending("bob-thread")).toHaveLength(1);
    manager.close(); manager = new RootConsentManager(path, options);
    expect(await manager.drain()).toEqual({ pending: 0, delivered: 1, errors: 0 });
    expect(judgments).toBe(1); expect(f.owners.bob.pending("bob-thread")).toHaveLength(1);
    expect(f.owners.bob.pending("bob-thread")[0]).toMatchObject({ senderId: "kenan-root", text: "Alice can meet Tuesday at 14:00. Nothing else was authorized.", source: "notification" });
    expect(await manager.drain()).toEqual({ pending: 0, delivered: 0, errors: 0 });
    expect(readFileSync(path).includes(Buffer.from(f.admission.memoryToken))).toBe(false);
    const disclosures = f.store.disclosures("bob", { threadId: "bob-thread", turnId: "proof" }, 100, "root").value;
    expect(disclosures.filter(log => log.kind === "consent-question")).toHaveLength(1);
    expect(disclosures.filter(log => log.kind === "consent-answer").map(log => log.to)).toEqual([["kenan"]]);
    expect(disclosures.filter(log => log.kind === "root-reply").some(log => log.finalReply === f.owners.bob.pending("bob-thread")[0].text)).toBe(true);
  } finally { manager?.close(); await f.close(); }
});

test("notification outbox survives refused delivery, lost ACK and restart without another model or duplicate message", async () => {
  const f = await fixture(); let manager: RootConsentManager | undefined;
  try {
    let unavailable = true, loseAck = true, sends = 0;
    const options = { memory: f.memory, enabled: () => true,
      executor: async () => { throw Error("Notifications must not invoke a model"); },
      bridge: { ...f.bridge, notify: async (input: Parameters<NonNullable<typeof f.bridge.notify>>[0]) => {
        sends++;
        if (unavailable) return { ok: false as const, message: "Connection refused" };
        const result = await f.bridge.notify!(input);
        if (loseAck) { loseAck = false; return { ok: false as const, message: "Lost ACK" }; }
        return result;
      } } };
    const path = join(f.root, "notifications.sqlite"); manager = new RootConsentManager(path, options);
    const input = { recipient: "alice", text: "The selected arrangement is approved.", subjects: ["alice", "bob"], obviouslyPrivate: false };
    const queued = await manager.notify(f.admission, "stable-tool-call", input);
    expect(queued).toMatchObject({ ok: true, value: { queued: true, delivered: false } });
    expect(sends).toBe(1);
    expect(await f.owners.alice.list()).toMatchObject({ ok: true, value: { threads: [] } });
    manager.close(); manager = new RootConsentManager(path, options);
    unavailable = false;
    expect(await manager.drain()).toEqual({ pending: 1, delivered: 0, errors: 1 });
    const threads = await f.owners.alice.list(); if (!threads.ok) throw Error("No notification inbox");
    expect(threads.value.threads).toHaveLength(1);
    const id = threads.value.threads[0].id;
    expect(f.owners.alice.pending(id)).toHaveLength(1);
    manager.close(); manager = new RootConsentManager(path, options);
    expect(await manager.drain()).toEqual({ pending: 0, delivered: 1, errors: 0 });
    expect(f.owners.alice.pending(id)).toHaveLength(1);
    expect(await manager.notify(f.admission, "stable-tool-call", input)).toMatchObject({ ok: true, value: { delivered: true } });
    expect(sends).toBe(3);
    expect(await manager.notify(f.admission, "stable-tool-call", { ...input, text: "Changed" })).toMatchObject({ ok: false });
    expect(readFileSync(path).includes(Buffer.from(f.admission.memoryToken))).toBe(false);
  } finally { manager?.close(); await f.close(); }
});

test("unknown notification recipient is rejected rather than retained for endless retry", async () => {
  const f = await fixture(); let manager: RootConsentManager | undefined;
  try {
    manager = new RootConsentManager(join(f.root, "notifications.sqlite"), { memory: f.memory, enabled: () => true, bridge: f.bridge,
      executor: async () => { throw Error("Not used"); } });
    expect(await manager.notify(f.admission, "unknown-person", { recipient: "missing", text: "Update", subjects: ["bob"], obviouslyPrivate: false })).toMatchObject({ ok: false });
    expect(await manager.drain()).toEqual({ pending: 0, delivered: 0, errors: 0 });
  } finally { manager?.close(); await f.close(); }
});

test("notification bridge rejects unknown recipients and only accepts its root capability", async () => {
  const f = await fixture();
  try {
    const body = { consentId: crypto.randomUUID(), person: "missing", text: "Update" };
    const request = (token: string) => new Request("http://router/v1/root-consent/notify", { method: "POST", headers: { [ROOT_CONSENT_HEADER]: token }, body: JSON.stringify(body) });
    expect((await f.router(request("forged")))?.status).toBe(404);
    expect((await f.router(request("c".repeat(64))))?.status).toBe(400);
    expect(await f.owners.alice.list()).toMatchObject({ ok: true, value: { threads: [] } });
  } finally { await f.close(); }
});

test("failed delivery never claims asked; untrusted capabilities and arbitrary answer lookups cannot reach subject APIs", async () => {
  const f = await fixture(); let manager: RootConsentManager | undefined;
  try {
    for (const token of ["forged", "a".repeat(64), "é".repeat(64)]) {
      const response = await f.router(new Request("http://router/v1/root-consent/question", { method: "POST", headers: { [ROOT_CONSENT_HEADER]: token }, body: "{}" }));
      expect(response?.status).toBe(404);
    }
    let fail = true;
    manager = new RootConsentManager(join(f.root, "consent.sqlite"), { memory: f.memory, enabled: () => true, executor: async () => ({ ok: false, error: "unavailable", message: "not used" }), bridge: { ...f.bridge, question: input => fail ? Promise.resolve({ ok: false, message: "No delivery" }) : f.bridge.question(input) } });
    const input = { subject: "alice", question: "May I give Bob the time?" };
    expect(await manager.request(f.admission, "meeting", input)).toMatchObject({ ok: false });
    expect(await f.owners.alice.list()).toMatchObject({ ok: true, value: { threads: [] } });
    fail = false; expect(await manager.request(f.admission, "meeting", input)).toMatchObject({ ok: true, value: { delivered: true } });
    const response = await f.router(new Request("http://router/v1/root-consent/answer", { method: "POST", headers: { [ROOT_CONSENT_HEADER]: "c".repeat(64) }, body: JSON.stringify({ consentId: crypto.randomUUID(), subject: "alice", threadId: "bob-thread", questionId: crypto.randomUUID() }) }));
    expect(response?.status).toBe(400);
  } finally { manager?.close(); await f.close(); }
});
