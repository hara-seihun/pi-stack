import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/store.js";
import { memoryService } from "../src/service.js";
import type { RootAdmission, RootResumeConsent } from "../src/contract.js";

test("consent continuation preserves original authenticated identity and audience across restart", () => {
  const root = mkdtempSync(join(tmpdir(), "consent-memory-")); const path = join(root, "memory.sqlite3");
  let store = new MemoryStore(path);
  try {
    const original = store.admitRoot("bob", "bob-thread", ["bob"], ["alice"]);
    const consent: RootResumeConsent = { rootSessionId: original.rootSessionId, consentId: "consent-1", subject: "alice", question: "May I tell Bob about this?", answer: "Only the scheduling detail." };
    expect(store.resumeConsent(consent)).toMatchObject({ ok: false });
    store.finalizeRootReply({ rootSessionId: original.rootSessionId, reply: "I'll ask Alice first.", subjects: ["alice"] });
    expect(store.resumeConsent(consent)).toMatchObject({ ok: false });
    expect(store.logConsent({ rootSessionId: original.rootSessionId, consentId: consent.consentId, subject: "alice", kind: "answer", text: consent.answer })).toMatchObject({ ok: false });
    const question = store.logConsent({ rootSessionId: original.rootSessionId, consentId: consent.consentId, subject: "alice", kind: "question", text: consent.question });
    expect(question.ok && question.value.to).toEqual(["alice"]);
    const answer = store.logConsent({ rootSessionId: original.rootSessionId, consentId: consent.consentId, subject: "alice", kind: "answer", text: consent.answer });
    expect(answer.ok && answer.value.to).toEqual(["kenan"]);
    expect(store.logConsent({ rootSessionId: original.rootSessionId, consentId: consent.consentId, subject: "bob", kind: "question", text: consent.question })).toMatchObject({ ok: false });
    expect(store.logConsent({ rootSessionId: original.rootSessionId, consentId: consent.consentId, subject: "alice", kind: "answer", text: "Changed answer" })).toMatchObject({ ok: false });
    store.close(); store = new MemoryStore(path);
    const resumed = store.resumeConsent(consent);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value).toMatchObject({ person: "bob", threadId: "bob-thread", recipients: ["bob"] });
    expect(resumed.value.rootSessionId).not.toBe(original.rootSessionId);
    expect(store.resolveSession(resumed.value.memoryToken)?.role).toBe("root");
    expect(store.resumeConsent(consent)).toEqual(resumed);
    expect(store.resumeConsent({ ...consent, answer: "Everything" })).toMatchObject({ ok: false });
    expect(store.disclosures("bob", { threadId: "bob-thread", turnId: "log" }, 100, "person").value.some(log => log.kind === "consent-answer")).toBe(false);
    expect(store.finalizeRootReply({ rootSessionId: resumed.value.rootSessionId, reply: "Alice approved the scheduling detail.", subjects: ["alice"] })).toMatchObject({ ok: true });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("only root service resumes/logs, no claimed identity fields, room roster rechecked", async () => {
  const store = new MemoryStore(":memory:"); let roomPeople = ["alice", "bob"];
  const server = memoryService({ store, auth: { supervisors: [{ person: "alice", token: "alice-supervisor" }, { person: "bob", token: "bob-supervisor" }], rootToken: "root-service" }, enabled: () => true, peerUid: () => undefined,
    roomAudience: (person, threadId) => person === "pi-rooms" && threadId === "room" ? { roomId: "room", people: roomPeople } : undefined });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (route: string, body: unknown, token = "root-service"): Promise<any> => fetch(url + route, { method: "POST", headers: { "x-kenan-memory-session": token }, body: JSON.stringify(body) }).then(response => response.json());
  try {
    const person = store.session("bob", "bob-thread");
    const original = store.admitRoot("pi-rooms", "room", roomPeople, ["alice"], "room");
    store.finalizeRootReply({ rootSessionId: original.rootSessionId, reply: "I'll ask Alice.", subjects: ["alice"] });
    const base = { rootSessionId: original.rootSessionId, consentId: "consent-2", subject: "alice" };
    const question = { ...base, kind: "question", text: "May I share the scheduling detail with the room?" };
    expect(await post("/v1/root/log-consent", question, person.token)).toMatchObject({ ok: false, error: "unauthenticated" });
    expect(await post("/v1/root/log-consent", { ...question, person: "alice" })).toMatchObject({ ok: false });
    expect(await post("/v1/root/log-consent", { ...question, subject: "unknown" })).toMatchObject({ ok: false });
    expect(await post("/v1/root/log-consent", question)).toMatchObject({ ok: true });
    expect(await post("/v1/root/log-consent", { ...base, kind: "answer", text: "Yes, just that detail." })).toMatchObject({ ok: true });
    const consent = { ...base, question: question.text, answer: "Yes, just that detail." };
    expect(await post("/v1/root/resume-consent", consent, person.token)).toMatchObject({ ok: false, error: "unauthenticated" });
    expect(await post("/v1/root/resume-consent", { ...consent, recipients: ["alice"] })).toMatchObject({ ok: false });
    roomPeople = ["alice", "bob", "carol"];
    expect(await post("/v1/root/resume-consent", consent)).toMatchObject({ ok: false, error: "unauthenticated" });
    roomPeople = ["alice", "bob"];
    const resumed = await post("/v1/root/resume-consent", consent);
    expect(resumed).toMatchObject({ ok: true, value: { person: "pi-rooms", threadId: "room", recipients: ["alice", "bob"], roomId: "room" } });
    expect(resumed.value.rootSessionId).not.toBe(original.rootSessionId);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
