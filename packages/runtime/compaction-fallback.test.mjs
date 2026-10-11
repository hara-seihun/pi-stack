import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { runCompactionWithFallback, selectCompactionFallback } from "./compaction-fallback.js";
import { patchCompactionFallback, patchCompactionFallbackCopies } from "./patch-compaction-fallback.mjs";
import { patchCompactionErrors } from "./patch-compaction-errors.mjs";
import { patchSummaryFailureFence } from "./patch-summary-recovery.mjs";

const opus = { provider: "anthropic", id: "opus", api: "anthropic-messages" };
const sol = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses" };
const next = { ...opus, id: "sonnet" };
const value = { summary: "preserved history", firstKeptEntryId: "tail", tokensBefore: 500, details: { readFiles: ["source"] }, usage: { totalTokens: 7 } };

test("selection is Sol for every other model; Sol aliases cannot loop and unavailable auth is explicit", () => {
  assert.equal(selectCompactionFallback(opus, [next, sol]).value, sol);
  assert.equal(selectCompactionFallback({ ...sol, provider: "openai-codex-2" }, [sol, { ...sol, provider: "openai-codex-3" }, next]).value, next);
  assert.equal(selectCompactionFallback(opus, [next]).error.code, "compaction-fallback-unavailable");
  assert.equal(selectCompactionFallback(sol, [sol]).ok, false);
});

test("one retry preserves original error, producer, cut and usage without mutating caller state", async () => {
  const log = [], controller = new AbortController();
  let calls = 0;
  const result = await runCompactionWithFallback({ model: opus, availableModels: () => [sol], signal: controller.signal,
    primary: async () => { throw new Error("Opus overload"); },
    fallback: async model => { calls++; assert.equal(model, sol); return value; }, record: data => log.push(data) });
  assert.equal(result.state, "ready");
  assert.equal(calls, 1);
  assert.deepEqual(log.map(x => x.state), ["primary-failed", "recovered"]);
  assert.equal(log[0].error.message, "Opus overload");
  assert.equal(result.value.details.compactionProducer.id, "gpt-6.1-sol");
  assert.equal(result.value.firstKeptEntryId, "tail");
  assert.equal(result.value.usage, value.usage);
  assert.deepEqual(result.value.details.readFiles, ["source"]);
  assert.equal(value.details.compactionProducer, undefined);
  assert.equal(opus.id, "opus");
});

test("failure is terminal after one alternate and cancellation never invokes fallback", async () => {
  for (const mode of ["failed", "cancel-hook", "cancel-signal"]) {
    let calls = 0; const log = [], controller = new AbortController();
    const result = await runCompactionWithFallback({ model: sol, availableModels: () => [sol, next], signal: controller.signal,
      primary: async () => {
        if (mode === "cancel-hook") return { state: "cancelled" };
        if (mode === "cancel-signal") controller.abort();
        throw new Error("native failed");
      }, fallback: async () => { calls++; throw new Error("alternate failed"); }, record: entry => log.push(entry) });
    assert.equal(result.state, mode === "failed" ? "failed" : "cancelled");
    assert.equal(calls, mode === "failed" ? 1 : 0);
    if (mode === "failed") {
      assert.match(result.error.message, /native failed.*alternate failed/);
      assert.equal(log.at(-1).fallbackModel.id, "sonnet");
    }
  }
});

test("stop during alternate discards its summary without a third attempt", async () => {
  const controller = new AbortController(), log = [];
  const result = await runCompactionWithFallback({ model: opus, availableModels: () => [sol], signal: controller.signal,
    primary: async () => { throw Error("first failed"); }, fallback: async () => { controller.abort(); return value; }, record: entry => log.push(entry) });
  assert.equal(result.state, "cancelled");
  assert.deepEqual(log.map(x => x.state), ["primary-failed"]);
});

test("primary success and unavailable fallback leave a truthful provenance/error", async () => {
  const signal = new AbortController().signal;
  const primary = await runCompactionWithFallback({ model: sol, availableModels: () => { throw Error("must not select"); }, signal,
    primary: async () => ({ state: "ready", value, fromExtension: true }), fallback: async () => { throw Error("must not retry"); }, record: () => {} });
  assert.equal(primary.value.details.compactionProducer.route, "primary");
  assert.equal(primary.fromExtension, true);
  const unavailable = await runCompactionWithFallback({ model: opus, availableModels: () => [], signal,
    primary: async () => { throw Error("original failure"); }, fallback: async () => { throw Error("must not retry"); }, record: () => {} });
  assert.equal(unavailable.error.code, "compaction-fallback-unavailable");
  assert.equal(unavailable.error.originalFailure.message, "original failure");
});

const base = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const source = patchCompactionFallback(patchSummaryFailureFence(patchCompactionErrors(readFileSync(join(base, "core/agent-session.js"), "utf8"))));
function methods(compact, prepare) {
  const adapter = source.slice(source.indexOf("async _runCompactionWithFallback("), source.indexOf("    async _runDefaultCompaction("));
  const manual = source.slice(source.indexOf("async compact(customInstructions)"), source.indexOf("async _checkCompaction("));
  const auto = source.slice(source.indexOf("async _runAutoCompaction("), source.indexOf("setAutoCompactionEnabled("));
  return new Function("runCompactionWithFallback", "portableCompactionPreparation", "buildSessionProjection", "compact", "prepareCompaction", "estimateMessagesTokens", "formatNoModelSelectedMessage", `return class { ${adapter}\n${manual}\n${auto} };`)(runCompactionWithFallback,
    preparation => ({ ok: true, value: preparation }), () => ({}), compact, prepare, () => 12, () => "missing model").prototype;
}

for (const mode of ["manual", "auto"]) for (const kind of ["default", "extension", "auth"]) test(`${mode} ${kind} failure uses common alternate boundary and persists only one compaction`, async () => {
  const preparation = { firstKeptEntryId: "tail", tokensBefore: 500 };
  const entries = [{ type: "message", id: "old" }, { type: "message", id: "tail" }], logs = [], calls = [], events = [];
  const proto = methods(async (...args) => { calls.push(args); return value; }, () => preparation);
  const session = Object.assign(Object.create(proto), {
    model: opus,
    abort: async () => {},
    _emit: event => events.push(event), _assertSummaryRecovery() {}, _summarizationRetryCallbacks: () => ({}),
    _getSummarizationRequestAuth: async model => { assert.equal(model, opus); if (kind === "auth") throw Error("auth failed"); return { model }; },
    _runDefaultCompaction: async () => { throw Error("default failed"); },
    _modelRuntime: { getAvailableSnapshot: () => [sol], streamSimple: () => { throw Error("stub compact does not stream"); } },
    settingsManager: { getCompactionSettings: () => ({}), getRetrySettings: () => ({}) },
    sessionManager: { getBranch: () => entries, appendCustomEntry: (type, data) => logs.push({ type, data }),
      appendCompaction: (...args) => entries.push({ type: "compaction", summary: args[0], details: args[3] }),
      getEntries: () => entries, buildSessionProjection: () => ({ messages: [] }) },
    _extensionRunner: { hasHandlers: () => kind === "extension", emit: async event => event.type === "session_before_compact" ? { error: "native failed" } : undefined },
    _refreshFinalizedContext() {}, _clearManualCompactionState() {}, _resolveIdleWaitIfIdle() {},
    _emitSessionCompactFailed: async () => {}, agent: { hasQueuedMessages: () => false },
  });
  if (mode === "manual") await session.compact("keep identifiers");
  else assert.equal(await session._runAutoCompaction("overflow", true, true), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], preparation);
  assert.equal(calls[0][1], sol);
  assert.equal(calls[0][2], undefined, "original provider credentials cannot reach alternate");
  assert.equal(session.model, opus);
  assert.equal(entries.filter(x => x.type === "compaction").length, 1);
  assert.equal(entries.at(-1).details.compactionProducer.provider, "openai-codex");
  assert.deepEqual(logs.map(x => x.data.state), ["primary-failed", "recovered"]);
  assert.equal(events.filter(x => x.type === "compaction_end").length, 1);
});

test("actual prose generator uses alternate runtime stream, not original credentials or native hooks", async () => {
  const { compact, prepareCompaction } = await import(new URL("./core/compaction/compaction.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const entries = ["earlier", "tail"].map((id, i) => ({ type: "message", id, parentId: i ? "earlier" : null,
    timestamp: new Date(i).toISOString(), message: { role: "user", content: `request ${id} ${"detail ".repeat(80)}`, timestamp: i } }));
  const preparation = prepareCompaction(entries, { enabled: true, reserveTokens: 1024, keepRecentTokens: 1 });
  assert.ok(preparation);
  const calls = [], log = [], alternate = { ...next, contextWindow: 32768, maxTokens: 4096 };
  const proto = methods(compact, () => preparation);
  const session = Object.assign(Object.create(proto), {
    model: sol, _getSummarizationRequestAuth: async model => ({ model, apiKey: "original-only" }),
    _extensionRunner: { hasHandlers: () => true, emit: async () => ({ error: "native checkpoint unavailable", cancel: true }) },
    _modelRuntime: { getAvailableSnapshot: () => [sol, alternate], streamSimple(model, context, options) {
      calls.push({ model, context, options });
      assert.equal(this, session._modelRuntime);
      return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "portable checkpoint" }], stopReason: "stop",
        usage: { input: 10, output: 3, totalTokens: 13, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } }) };
    } },
    sessionManager: { appendCustomEntry: (_type, data) => log.push(data) },
    settingsManager: { getRetrySettings: () => ({ enabled: false }) }, _summarizationRetryCallbacks: () => ({}),
  });
  const result = await session._runCompactionWithFallback(sol, preparation, entries, undefined, new AbortController().signal, "overflow", true);
  assert.equal(result.state, "ready");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, alternate);
  assert.equal(calls[0].options.apiKey, undefined);
  assert.match(JSON.stringify(calls[0].context.messages), /request earlier/);
  assert.equal(result.value.summary, "portable checkpoint");
  assert.equal(result.value.details.compactionProducer.id, "sonnet");
  assert.equal(session.model, sol);
  assert.equal(log[0].error.message, "native checkpoint unavailable");
});

test("pinned patch is idempotent, syntactically valid and rejects missing prerequisite patches", () => {
  assert.equal(patchCompactionFallback(source), source);
  assert.equal(patchCompactionErrors(source), source, "reapplying the prerequisite cannot corrupt the new boundary");
  assert.equal(patchSummaryFailureFence(source), source);
  assert.throws(() => patchCompactionFallback("class Session {}"), /requires/);
  const dir = mkdtempSync(join(tmpdir(), "pi-compaction-fallback-"));
  try {
    const file = join(dir, "agent-session.mjs"); writeFileSync(file, source);
    execFileSync(process.execPath, ["--check", file]);
    const core = join(dir, "@earendil-works/pi-coding-agent/dist/core");
    mkdirSync(core, { recursive: true });
    writeFileSync(join(core, "agent-session.js"), source);
    patchCompactionFallbackCopies(dir);
    assert.equal(readFileSync(join(core, "agent-session.js"), "utf8"), source);
    for (const name of ["compaction-fallback.js", "compaction-fallback-history.js"])
      assert.equal(readFileSync(join(core, name), "utf8"), readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
