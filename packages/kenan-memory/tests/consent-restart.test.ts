import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/store.js";

test("a delivered question and human answer survive an executor crash before original reply selection", () => {
  const root = mkdtempSync(join(tmpdir(), "consent-interruption-")); const path = join(root, "memory.sqlite3");
  let store = new MemoryStore(path);
  try {
    const original = store.admitRoot("bob", "bob-thread", ["bob"], ["alice"]);
    const consent = { rootSessionId: original.rootSessionId, subject: "alice", consentId: "crashed-executor-consent", question: "May I share the scheduling detail with Bob?", answer: "Yes, just the date." };
    expect(store.logConsent({ rootSessionId: original.rootSessionId, subject: consent.subject, consentId: consent.consentId, kind: "question", text: consent.question }).ok).toBe(true);
    store.close(); store = new MemoryStore(path);
    expect(store.logConsent({ rootSessionId: original.rootSessionId, subject: consent.subject, consentId: consent.consentId, kind: "answer", text: consent.answer }).ok).toBe(true);
    const result = store.resumeConsent(consent);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ person: "bob", threadId: "bob-thread", recipients: ["bob"] });
    expect(store.resolveSession(original.memoryToken)).toBeUndefined();
    expect(store.resolveSession(result.value.memoryToken)?.role).toBe("root");
    expect(store.db.query("SELECT id FROM disclosures WHERE id=?").get(`root-reply-${original.rootSessionId}`)).toBeNull();
    expect(store.finalizeRootReply({ rootSessionId: original.rootSessionId, reply: "Late stale executor answer", subjects: ["alice"] })).toMatchObject({ ok: false });
    store.close(); store = new MemoryStore(path);
    expect(store.resumeConsent(consent)).toEqual(result);
    expect(store.finalizeRootReply({ rootSessionId: original.rootSessionId, reply: "Stale after restart", subjects: [] })).toMatchObject({ ok: false });
    expect(store.finalizeRootReply({ rootSessionId: result.value.rootSessionId, reply: "Alice approved sharing just the date.", subjects: ["alice"] })).toMatchObject({ ok: true });
    expect(store.resolveSession(result.value.memoryToken)).toBeUndefined();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
