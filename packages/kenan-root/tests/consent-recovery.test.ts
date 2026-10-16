import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RootConsentManager, type RootMemoryRpc } from "../src/consent";
import { consentInboxId, type ConsentBridge } from "../src/consent-contract";
import type { RootAdmission } from "../../kenan-memory/src/contract";

test("validated unanswered recovery clears stale errors and retains original consent custody", async () => {
  const root = mkdtempSync(join(tmpdir(), "consent-recovery-")), path = join(root, "consent.sqlite");
  let manager: RootConsentManager | undefined;
  let observation: "failed" | "mismatched" | "valid" = "failed";
  let deliveredQuestion = "", deliveries = 0, executions = 0, replies = 0;
  const admission: RootAdmission = { person: "bob", threadId: "original-bob-thread", rootSessionId: "original-root-session", recipients: ["bob"], subjects: ["alice", "bob"], memoryToken: "fixture-root-token" };
  const bridge: ConsentBridge = {
    question: async input => { deliveries++; deliveredQuestion = input.text; return { ok: true, value: { threadId: consentInboxId(input.consentId), questionId: "original-question-id" } }; },
    answer: async input => {
      expect(input.threadId).toBe(consentInboxId(input.consentId));
      expect(input.questionId).toBe("original-question-id");
      expect(input.subject).toBe("alice");
      if (observation === "failed") return { ok: false, message: "Owner unavailable" };
      return { ok: true, value: { question: observation === "mismatched" ? "Different question" : deliveredQuestion } };
    },
    reply: async () => { replies++; throw Error("An unanswered consent must not reply"); },
  };
  const memory: RootMemoryRpc = async <T>() => ({ ok: true, value: undefined as T });
  const options = { memory, enabled: () => true, bridge,
    executor: async () => { executions++; throw Error("An unanswered consent must not execute"); } };
  try {
    manager = new RootConsentManager(path, options);
    const asked = await manager.request(admission, "meeting", { subject: "alice", question: "May I share the meeting time?" });
    if (!asked.ok) throw Error("Expected original consent delivery");
    const read = () => {
      const db = new Database(path, { readonly: true });
      try { return JSON.parse((db.query("SELECT data FROM root_consent WHERE id=?").get(asked.value.consentId) as { data: string }).data); }
      finally { db.close(); }
    };
    const original = read();
    expect(original).toMatchObject({ id: asked.value.consentId, state: "waiting", original: { person: "bob", threadId: admission.threadId, rootSessionId: admission.rootSessionId }, receipt: { threadId: consentInboxId(asked.value.consentId), questionId: "original-question-id" }, question: deliveredQuestion });
    expect(await manager.drain()).toEqual({ pending: 1, delivered: 0, errors: 1 });
    expect(read().lastError).toBe("Owner unavailable");
    manager.close(); manager = new RootConsentManager(path, options);
    observation = "mismatched";
    expect(await manager.drain()).toEqual({ pending: 1, delivered: 0, errors: 1 });
    expect(read().lastError).toBe("Subject's question does not match the recorded consent");
    manager.close(); manager = new RootConsentManager(path, options);
    observation = "valid";
    expect(await manager.drain()).toEqual({ pending: 1, delivered: 0, errors: 0 });
    expect(read()).toEqual(original);
    manager.close(); manager = new RootConsentManager(path, options);
    expect(await manager.drain()).toEqual({ pending: 1, delivered: 0, errors: 0 });
    expect(read()).toEqual(original);
    expect(deliveries).toBe(1);
    expect(executions).toBe(0);
    expect(replies).toBe(0);
  } finally { manager?.close(); rmSync(root, { recursive: true, force: true }); }
});
