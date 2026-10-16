import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSessionProjection, SessionManager } from "@earendil-works/pi-coding-agent";
import { portableCompactionPreparation } from "./compaction-fallback-history.js";

const { prepareCompaction } = await import(new URL("./core/compaction/compaction.js", import.meta.resolve("@earendil-works/pi-coding-agent")));

const settings = { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 };
const nativeDetails = {
  kind: "openai-codex-native-compaction", version: 2,
  modelKey: "openai-codex-responses:gpt-test",
  replacementHistory: [{ type: "compaction", encrypted_content: "do-not-send-encrypted-history" }],
};
const nativeSummary = "Codex server-side checkpoint. pi-stored-jsonl-history: /private/session.jsonl";
const text = message => typeof message.content === "string"
  ? message.content
  : (message.content ?? []).filter(block => block.type === "text").map(block => block.text).join("");
const texts = messages => messages.map(text);
const user = (sm, content) => sm.appendMessage({ role: "user", content, timestamp: sm.getBranch().length + 1 });
const assistant = (sm, content) => sm.appendMessage({
  role: "assistant", content: [{ type: "text", text: content }],
  timestamp: sm.getBranch().length + 1, api: "openai-codex-responses", provider: "openai-codex", model: "gpt-test",
});
const checkpoint = (sm, firstKeptEntryId) => sm.appendCompaction(nativeSummary, firstKeptEntryId, 10000, nativeDetails);
const restore = sm => {
  const branch = sm.getBranch();
  const preparation = prepareCompaction(branch, settings);
  assert.ok(preparation, "fixture has a real SDK compaction preparation");
  const result = portableCompactionPreparation(preparation, branch, buildSessionProjection);
  assert.equal(result.ok, true, JSON.stringify(result));
  return { branch, preparation, portable: result.value };
};

function editedFixture() {
  const sm = SessionManager.inMemory("/fixture");
  sm.appendMessage({ role: "system", content: "system-state-not-conversation", timestamp: 0 });
  user(sm, "original-history-key");
  const replaced = assistant(sm, "raw-replaced-message");
  const omitted = user(sm, "raw-omitted-message");
  sm.appendContextEdit(replaced, { content: "effective-replacement" });
  sm.appendContextEdit(omitted, null);
  const retained = user(sm, "native-retained-history");
  assistant(sm, "native-retained-answer");
  checkpoint(sm, retained);
  user(sm, "post-native-history");
  assistant(sm, "post-native-answer");
  const cut = user(sm, "exact-retained-tail");
  return { sm, cut };
}

test("reconstructs edited original native history and commits the same SDK cut and retained tail", () => {
  const { sm, cut } = editedFixture();
  const before = JSON.stringify(sm.getBranch());
  const { preparation, portable } = restore(sm);
  assert.equal(preparation.previousSummary, nativeSummary);
  assert.equal(preparation.firstKeptEntryId, cut);
  assert.deepEqual(texts(portable.messagesToSummarize), [
    "original-history-key", "effective-replacement", "native-retained-history", "native-retained-answer",
    "post-native-history", "post-native-answer",
  ]);
  assert.equal(portable.previousSummary, undefined);
  assert.equal(portable.firstKeptEntryId, preparation.firstKeptEntryId);
  assert.equal(portable.tokensBefore, preparation.tokensBefore);
  assert.strictEqual(portable.settings, preparation.settings);
  assert.strictEqual(portable.fileOps, preparation.fileOps);
  assert.equal(portable.isSplitTurn, preparation.isSplitTurn);
  assert.deepEqual(portable.turnPrefixMessages, []);
  assert.equal(JSON.stringify(sm.getBranch()), before, "recovery does not rewrite session custody");
  const tailBefore = buildSessionProjection(sm.getBranch()).entries
    .slice(buildSessionProjection(sm.getBranch()).entries.findIndex(entry => entry.sourceEntry.id === cut))
    .flatMap(entry => entry.messages);
  sm.appendCompaction("Portable prose result", portable.firstKeptEntryId, portable.tokensBefore);
  assert.deepEqual(buildSessionProjection(sm.getBranch()).messages.filter(message =>
    message.role !== "system" && message.role !== "compactionSummary"), tailBefore);
  assert.ok(!JSON.stringify(portable).includes("do-not-send-encrypted-history"));
  assert.ok(!JSON.stringify(portable).includes("pi-stored-jsonl-history"));
});

test("retains the earlier portable summary across repeated native checkpoints", () => {
  const sm = SessionManager.inMemory("/fixture");
  user(sm, "already-summarized-raw-history");
  const proseTail = user(sm, "portable-retained-history");
  sm.appendCompaction("Earlier portable history summary", proseTail, 500);
  const edited = assistant(sm, "raw-later-replacement");
  sm.appendContextEdit(edited, { content: "edited-after-portable-summary" });
  const nativeTail = user(sm, "first-native-retained-history");
  assistant(sm, "first-native-answer");
  checkpoint(sm, nativeTail);
  const secondTail = user(sm, "second-native-retained-history");
  assistant(sm, "second-native-answer");
  checkpoint(sm, secondTail);
  user(sm, "new-history");
  assistant(sm, "new-answer");
  const cut = user(sm, "keep-this-exact-tail");
  const { portable } = restore(sm);
  assert.equal(portable.firstKeptEntryId, cut);
  assert.equal(portable.previousSummary, "Earlier portable history summary");
  assert.deepEqual(texts(portable.messagesToSummarize), [
    "portable-retained-history", "edited-after-portable-summary", "first-native-retained-history", "first-native-answer",
    "second-native-retained-history", "second-native-answer", "new-history", "new-answer",
  ]);
  assert.ok(!JSON.stringify(portable).includes("already-summarized-raw-history"));
});

test("uses provenance to preserve the SDK split-turn partition without retaining raw edited prefix", () => {
  const { sm } = editedFixture();
  const turn = sm.getLeafId();
  assistant(sm, "first-turn-answer");
  const cut = sm.appendContextEdit(turn, { content: "effective-current-turn" });
  assistant(sm, "retained-answer");
  const { preparation, portable } = restore(sm);
  assert.equal(preparation.isSplitTurn, true);
  assert.equal(portable.isSplitTurn, true);
  assert.equal(portable.firstKeptEntryId, cut);
  assert.deepEqual(texts(portable.turnPrefixMessages), ["effective-current-turn", "first-turn-answer"]);
  assert.deepEqual(texts(portable.messagesToSummarize), [
    "original-history-key", "effective-replacement", "native-retained-history", "native-retained-answer",
    "post-native-history", "post-native-answer",
  ]);
});

test("a cut inside a native checkpoint's earlier retained range stays exact", () => {
  const { sm } = editedFixture();
  const branch = sm.getBranch();
  const retained = branch.find(entry => entry.type === "message" && text(entry.message) === "native-retained-history");
  const latest = branch.findLast(entry => entry.type === "compaction");
  const preparation = prepareCompaction(branch, settings);
  const originalProjection = buildSessionProjection(branch);
  const cutIndex = originalProjection.entries.findIndex(entry => entry.sourceEntry.id === retained.id);
  const cutPreparation = { ...preparation, firstKeptEntryId: retained.id, isSplitTurn: false, turnPrefixMessages: [], messagesToSummarize: [] };
  assert.ok(cutIndex > originalProjection.entries.findIndex(entry => entry.sourceEntry.id === latest.id));
  const result = portableCompactionPreparation(cutPreparation, branch, buildSessionProjection);
  assert.equal(result.ok, true);
  assert.equal(result.value.firstKeptEntryId, retained.id);
  assert.deepEqual(texts(result.value.messagesToSummarize), ["original-history-key", "effective-replacement"]);
});

test("no native latest compaction leaves preparation untouched and does not need projection", () => {
  const { sm } = editedFixture();
  const { preparation } = restore(sm);
  sm.appendCompaction("Portable summary", preparation.firstKeptEntryId, 10);
  const result = portableCompactionPreparation(preparation, sm.getBranch(), undefined);
  assert.equal(result.ok, true);
  assert.strictEqual(result.value, preparation);
  assert.strictEqual(portableCompactionPreparation(preparation, [], undefined).value, preparation);
});

test("missing original custody, missing cut and SDK projection failure are explicit errors", () => {
  const { sm } = editedFixture();
  const branch = sm.getBranch();
  const preparation = prepareCompaction(branch, settings);
  const detached = branch.slice(1);
  assert.equal(portableCompactionPreparation(preparation, detached, buildSessionProjection).error.code, "portable_history_unavailable");
  assert.equal(portableCompactionPreparation({ ...preparation, firstKeptEntryId: "missing" }, branch, buildSessionProjection).error.code, "portable_history_unavailable");
  const nativeOnly = branch.slice(branch.findIndex(entry => entry.type === "compaction"));
  nativeOnly[0] = { ...nativeOnly[0], parentId: null, firstKeptEntryId: nativeOnly[0].id };
  assert.equal(portableCompactionPreparation(preparation, nativeOnly, buildSessionProjection).error.code, "portable_history_unavailable");
  assert.equal(portableCompactionPreparation(preparation, branch, () => { throw new Error("foreign projection failure"); }).error.code, "portable_history_projection_failed");
  assert.equal(portableCompactionPreparation(preparation, branch, () => ({ entries: [] })).error.code, "portable_history_unavailable");
});
