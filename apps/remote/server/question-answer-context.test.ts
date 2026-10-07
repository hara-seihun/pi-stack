import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadService } from "pi-orchestrator/api";
import { questionAnswerContext } from "./question-answer-context";
import { deriveTranscriptItems } from "./transcript-items";
import { sha256 } from "./sync";

test("projects root answers over captured local context and streams a visible user receipt without running Pi", async () => {
  const root = mkdtempSync(join(tmpdir(), "consent-context-"));
  let opened = 0;
  const owner = new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: root, capacity: { mode: "unmanaged" },
    openSession: async () => { opened++; throw Error("Consent answers must not open Pi"); } });
  try {
    await owner.start();
    await owner.spawn({ requestId: "inbox", id: "inbox", cwd: root, metadata: { rootConsent: true } });
    const asked = await owner.ask({ requestId: "consent:fixture:question", threadId: "inbox", questions: [{ question: "Share the time?" }] });
    if (!asked.ok) throw Error(asked.error.message);
    const questionId = asked.value.questionIds[0]!;
    const document = JSON.stringify({ systemPrompt: "Captured context", tools: [], messages: [{ role: "user", timestamp: 1, content: "Earlier conversation" }] });
    const captured = { capturedAt: 1, document, hash: sha256(document) };
    const before = questionAnswerContext(owner, "inbox", captured)!;
    expect(questionAnswerContext(owner, "inbox", null)).toBeNull();
    expect(await owner.answer({ threadId: "inbox", questionId, selectedSuggestionIds: [], text: "Only the time." })).toMatchObject({ ok: true });
    owner.reconcile(); await new Promise(resolve => setImmediate(resolve));
    const projected = questionAnswerContext(owner, "inbox", captured)!;
    expect(projected.hash).not.toBe(before.hash);
    expect(JSON.parse(projected.document).messages).toMatchObject([{ content: "Earlier conversation" }, { role: "user", questionId, rootConsent: true }]);
    expect(questionAnswerContext(owner, "inbox", projected)).toEqual(projected);
    expect(JSON.parse(questionAnswerContext(owner, "inbox", null)!.document).messages).toHaveLength(1);
    const items = deriveTranscriptItems(JSON.parse(projected.document));
    expect(items.at(-1)?.head).toMatchObject({ kind: "user", text: expect.stringContaining("Only the time.") });
    expect(opened).toBe(0);
    expect(owner.pending("inbox")).toEqual([]);
    expect(captured.document).toBe(document);
    await owner.spawn({ requestId: "ordinary", id: "ordinary", cwd: root });
    expect(questionAnswerContext(owner, "ordinary", captured)).toBe(captured);
    expect(questionAnswerContext(owner, "ordinary", null)).toBeNull();
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});
