import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchSummaryRecovery, patchSummaryFailureFence, patchSummaryRecoveryCopies } from "./patch-summary-recovery.mjs";
import { patchCompactionErrors } from "./patch-compaction-errors.mjs";

const base = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const bundled = readdirSync(join(base, "bundle/chunks")).filter(name => name.endsWith(".js")).map(name => join(base, "bundle/chunks", name));
const summaries = [join(base, "core/compaction/compaction.js"), ...bundled.filter(path => readFileSync(path, "utf8").includes("async function completeSummarization("))];
const sessions = [join(base, "core/agent-session.js"), ...bundled.filter(path => readFileSync(path, "utf8").includes("async _runAutoCompaction("))];
assert.equal(summaries.length, 2);
assert.equal(sessions.length, 2);
const model = { api: "anthropic-messages", id: "fixture-opus", contextWindow: 32768, maxTokens: 4096 };
const response = (stopReason = "stop", extra = {}) => ({ stopReason, content: [{ type: "text", text: "checkpoint" }], usage: { input: 10, output: 2, totalTokens: 12, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra });
const combine = (a, b) => ({ ...a, input: a.input + b.input, output: a.output + b.output, totalTokens: a.totalTokens + b.totalTokens });
const context = text => ({ systemPrompt: "summarize only", messages: [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }] });
const prompt = text => `<conversation>\n${text}\n</conversation>\n\nUse the checkpoint format.`;

for (const path of summaries) {
  const source = patchSummaryRecovery(readFileSync(path, "utf8"));
  const name = path.includes("chunks") ? "bundled CLI" : "SDK";
  const start = source.indexOf("/* Pi Stack bounded summary recovery */");
  const end = source.indexOf("async function completeSummarizationOnce(", start);
  const wrapper = source.slice(start, end).replace(/export /g, "");
  const run = request => new Function("completeSummarizationOnce", "combineUsage", `${wrapper}; return completeSummarization;`)(request, combine);
  test(`${name}: bounded length recovery removes chat reasoning and accounts both attempts`, async () => {
    const calls = [];
    const fn = run(async (_model, ctx, options) => { calls.push({ ctx, options }); return response(calls.length === 1 ? "length" : "stop"); });
    const result = await fn(model, context(prompt("history")), { maxTokens: 1024, reasoning: "max" });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.reasoning, "max");
    assert.equal(calls[1].options.reasoning, undefined);
    assert.match(calls[1].ctx.messages[0].content[0].text, /1000 words/);
    assert.equal(result.usage.totalTokens, 24);
    assert.equal(result.stopReason, "stop");
    assert.equal(patchSummaryRecovery(source), source);
    const wrapperBoundary = source.search(/(?:export )?async function completeSummarization\(/);
    const precedingRepair = source.slice(0, start) + "/* Pi Stack bounded summary recovery */\nasync function boundedSummarization() { throw new Error('preceding repair'); }\n" + source.slice(wrapperBoundary);
    assert.equal(patchSummaryRecovery(precedingRepair), source, "reapplying deployment must replace the preceding helper, not keep its marker");
  });
  test(`${name}: a single giant Unicode message is reduced without dropping source or repeating oversized requests`, async () => {
    const history = "source🙂".repeat(8000);
    let reconstructed = "", calls = 0;
    const fn = run(async (_model, ctx, options) => {
      const text = ctx.messages[0].content[0].text;
      assert.ok(Buffer.byteLength(text) <= (model.contextWindow - options.maxTokens - 8192) / 2);
      const segment = text.slice("<conversation>\n".length, text.indexOf("\n</conversation>"));
      reconstructed += segment.replace(/^\[Checkpoint from preceding segments\]:\ncheckpoint\n\n/, "");
      calls++;
      return response();
    });
    const result = await fn(model, context(prompt(history)), { maxTokens: 1024, reasoning: "high" });
    assert.equal(reconstructed, history);
    assert.ok(calls > 1 && calls <= 32);
    assert.equal(result.usage.totalTokens, calls * 12);
  });
  test(`${name}: oversized previous checkpoint is read completely before new conversation, without mutating the input`, async () => {
    const prior = "historical🙂".repeat(5000);
    const history = "new conversation🛠".repeat(1500);
    const original = context(`<conversation>\n${history}\n</conversation>\n\n<previous-summary>\n${prior}\n</previous-summary>\n\nPreserve the user's focus.`);
    const saved = structuredClone(original);
    let seenPrior = "", seenHistory = "", calls = 0;
    const fn = run(async (_model, ctx, options) => {
      const text = ctx.messages[0].content[0].text;
      assert.ok(Buffer.byteLength(text) <= (model.contextWindow - options.maxTokens - 8192) / 2);
      assert.match(text, /Preserve the user's focus/);
      assert.equal(options.reasoning, undefined);
      const summary = text.match(/<previous-summary>\n([\s\S]*?)\n<\/previous-summary>/)?.[1];
      if (summary !== undefined) {
        assert.equal(seenHistory, "", "historical checkpoint must be reduced before new turns");
        seenPrior += summary.replace(/^\[Reduced preceding summary segments\]:\ncheckpoint\n\n/, "");
      } else {
        assert.equal(seenPrior, prior);
        seenHistory += text.slice("<conversation>\n".length, text.indexOf("\n</conversation>")).replace(/^\[Checkpoint from preceding segments\]:\ncheckpoint\n\n/, "");
      }
      calls++;
      return response();
    });
    const result = await fn(model, original, { maxTokens: 1024, reasoning: "max" });
    assert.equal(seenPrior, prior);
    assert.equal(seenHistory, history);
    assert.deepEqual(original, saved);
    assert.equal(result.usage.totalTokens, calls * 12);
    assert.equal(result.stopReason, "stop");
  });
  test(`${name}: summary-only recovery preserves every checkpoint character and charges capped attempts`, async () => {
    const prior = "prior🙂".repeat(5000);
    let seen = "", calls = 0;
    const fn = run(async (_model, ctx, options) => {
      const text = ctx.messages[0].content[0].text;
      assert.ok(Buffer.byteLength(text) <= (model.contextWindow - options.maxTokens - 8192) / 2);
      calls++;
      if (calls === 1) return response("length");
      seen += text.match(/<previous-summary>\n([\s\S]*?)\n<\/previous-summary>/)[1].replace(/^\[Reduced preceding summary segments\]:\ncheckpoint\n\n/, "");
      return response();
    });
    const result = await fn(model, context(`<conversation>\n\n</conversation>\n\n<previous-summary>\n${prior}\n</previous-summary>\n\nKeep identifiers.`), { maxTokens: 1024 });
    assert.equal(seen, prior);
    assert.equal(result.usage.totalTokens, calls * 12);
  });
  test(`${name}: oversized generated checkpoints are reduced before consuming the next source segment`, async () => {
    const history = "source".repeat(5000);
    const generated = "generated🙂".repeat(1500);
    let seenHistory = "", seenCheckpoint = "", calls = 0;
    const fn = run(async (_model, ctx, options) => {
      const text = ctx.messages[0].content[0].text;
      assert.ok(Buffer.byteLength(text) <= (model.contextWindow - options.maxTokens - 8192) / 2);
      const summary = text.match(/<previous-summary>\n([\s\S]*?)\n<\/previous-summary>/)?.[1];
      if (summary !== undefined) seenCheckpoint += summary.replace(/^\[Reduced preceding summary segments\]:\ncheckpoint\n\n/, "");
      else seenHistory += text.slice("<conversation>\n".length, text.indexOf("\n</conversation>")).replace(/^\[Checkpoint from preceding segments\]:\ncheckpoint\n\n/, "");
      return ++calls === 1 ? response("stop", { content: [{ type: "text", text: generated }] }) : response();
    });
    const result = await fn(model, context(prompt(history)), { maxTokens: 1024 });
    assert.equal(seenHistory, history);
    assert.equal(seenCheckpoint, generated);
    assert.equal(result.usage.totalTokens, calls * 12);
  });
  test(`${name}: checkpoint reduction failures, cancellation, unshrinkable outputs and fixed instructions stay terminal`, async () => {
    const prior = "p".repeat(20000);
    const input = context(`<conversation>\nnew turn\n</conversation>\n\n<previous-summary>\n${prior}\n</previous-summary>\n\nKeep identifiers.`);
    for (const stopReason of ["error", "length", "aborted", "stop"]) {
      let calls = 0;
      const failure = response(stopReason, stopReason === "stop" ? { content: [{ type: "toolCall", id: "bad", name: "read", arguments: {} }] } : {});
      const result = await run(async () => { calls++; return failure; })(model, input, { maxTokens: 1024 });
      assert.equal(result.stopReason, stopReason);
      assert.equal(calls, stopReason === "length" ? 2 : 1);
    }
    const abort = new AbortController();
    let calls = 0;
    await assert.rejects(run(async () => { calls++; abort.abort(); return response(); })(model, input, { maxTokens: 1024, signal: abort.signal }), { name: "AbortError" });
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(run(async () => { calls++; return response("stop", { content: [{ type: "text", text: prior }] }); })(model, input, { maxTokens: 1024 }), /exceeded 32 requests/);
    assert.equal(calls, 32);
    calls = 0;
    await assert.rejects(run(async () => { calls++; return response(); })(model, context(`${prompt("new turn")}\n${"instructions".repeat(2000)}`), { maxTokens: 1024 }), /instructions exceed.*budget/);
    assert.equal(calls, 0);
  });
  test(`${name}: provider overflow shrinks segments; repeated output cap and cancellation stay terminal`, async () => {
    let calls = 0;
    const fn = run(async () => ++calls === 1 ? response("error", { errorMessage: "prompt is too long: 1221206 tokens > 1000000 maximum" }) : response());
    assert.equal((await fn(model, context(prompt("history")), { maxTokens: 1024 })).stopReason, "stop");
    assert.equal(calls, 2);
    calls = 0;
    const capped = run(async () => { calls++; return response("length"); });
    assert.equal((await capped(model, context(prompt("history")), { maxTokens: 1024 })).stopReason, "length");
    assert.equal(calls, 2);
    const abort = new AbortController();
    calls = 0;
    const cancelled = run(async () => { calls++; abort.abort(); return response("length"); });
    await assert.rejects(cancelled(model, context(prompt("history")), { maxTokens: 1024, signal: abort.signal }), { name: "AbortError" });
    assert.equal(calls, 1);
  });
  test(`${name}: recovery is bounded even when history or repeated overflow cannot fit`, async () => {
    let calls = 0;
    const fn = run(async () => { calls++; return response(); });
    await assert.rejects(fn(model, context(prompt("x".repeat(500000))), { maxTokens: 1024 }), /exceeded 32 requests/);
    assert.equal(calls, 32);
    calls = 0;
    const rejected = run(async () => { calls++; return response("error", { errorMessage: "prompt is too long" }); });
    await assert.rejects(rejected(model, context(prompt("history")), { maxTokens: 1024 }), /exceed.*budget/);
    assert.ok(calls < 10);
  });
}

for (const path of sessions) test(`${path.includes("chunks") ? "bundled CLI" : "SDK"}: failed automatic prose compaction fences requests across reload/aliases until manual success`, async () => {
  const source = patchSummaryFailureFence(patchCompactionErrors(readFileSync(path, "utf8")));
  assert.equal(patchSummaryFailureFence(source), source);
  const start = source.indexOf("/* Pi Stack durable summary failure fence */");
  const end = source.indexOf("async _dispatchTurnEndBoundary(", start);
  const methods = new Function(`return class { ${source.slice(start, end)} };`)().prototype;
  const branch = [];
  const events = [];
  let compactRequests = 0;
  const session = {
    model, settingsManager: { getCompactionSettings: () => ({}) }, _getSummarizationRequestAuth: async () => ({}),
    sessionManager: { getBranch: () => branch, appendCustomEntry: (customType, data) => branch.push({ type: "custom", customType, data }), buildSessionProjection: () => ({ messages: [] }) },
    _emit: event => events.push(event), _emitSessionCompactFailed: async () => {},
    _extensionRunner: { hasHandlers: () => true, emit: async () => { compactRequests++; return { error: "generation hit the token cap" }; } },
    agent: { state: { tools: [] }, async runWithLifecycle(executor) { try { await executor(); } catch {} }, async processEvents() {} },
    _resolveIdleWaitIfIdle() {}, _assertSummaryRecovery: methods._assertSummaryRecovery,
  };
  const autoStart = source.indexOf("async _runAutoCompaction(");
  const autoEnd = source.indexOf("setAutoCompactionEnabled(", autoStart);
  const prepare = () => ({});
  const auto = new Function("prepareCompaction", "prepareCompaction2", `return class { ${source.slice(autoStart, autoEnd)} };`)(prepare, prepare).prototype._runAutoCompaction;
  assert.equal(await auto.call(session, "overflow", true), false);
  assert.equal(branch.length, 1);
  assert.equal(await auto.call(session, "threshold", false), false);
  assert.equal(compactRequests, 1, "automatic compaction must not resubmit the failed summary");
  assert.equal(branch.length, 1, "rejections do not multiply durable failure records");
  methods._installAgentRequestProjection.call(session);
  let inference = 0;
  const request = async () => { await session.agent.prepareRequest({ context: {} }); inference++; };
  await assert.rejects(request(), /Context rejected:.*token cap/);
  assert.equal(inference, 0);
  const reloaded = { ...session, model: { ...model, provider: "anthropic-99" } };
  assert.throws(() => methods._assertSummaryRecovery.call(reloaded), /Automatic resubmission is blocked/);
  reloaded.model = { ...model, id: "another-model" };
  assert.doesNotThrow(() => methods._assertSummaryRecovery.call(reloaded));
  branch.push({ type: "compaction" });
  await request();
  assert.equal(inference, 1);
  session._extensionRunner.emit = async () => ({ cancel: true });
  await auto.call(session, "threshold", false);
  assert.equal(branch.length, 2, "operator cancellation creates no failure fence");
});

test("actual SDK default summarizer retries a capped thinking response instead of committing an incomplete summary", async () => {
  const file = join(base, "core/compaction/compaction.js");
  const source = patchSummaryRecovery(readFileSync(file, "utf8")).replace(/(^import[\s\S]*?\bfrom )"([^"]+)"/gm, (_match, prefix, specifier) => `${prefix}"${specifier.startsWith(".") ? new URL(specifier, pathToFileURL(file)).href : import.meta.resolve(specifier)}"`);
  const { generateSummaryWithUsage } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const calls = [];
  const stream = async (_model, ctx, options) => ({ result: async () => { calls.push({ ctx, options }); return response(calls.length === 1 ? "length" : "stop"); } });
  const result = await generateSummaryWithUsage([{ role: "user", content: "incident history", timestamp: 1 }], model, 16384, "fixture", undefined, undefined, undefined, undefined, "high", stream);
  assert.equal(result.text, "checkpoint");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.reasoning, undefined);
});

test("actual SDK summarizes a giant prior checkpoint completely before incorporating new turns", async () => {
  const file = join(base, "core/compaction/compaction.js");
  const source = patchSummaryRecovery(readFileSync(file, "utf8")).replace(/(^import[\s\S]*?\bfrom )"([^"]+)"/gm, (_match, prefix, specifier) => `${prefix}"${specifier.startsWith(".") ? new URL(specifier, pathToFileURL(file)).href : import.meta.resolve(specifier)}"`);
  const { generateSummaryWithUsage } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const prior = "checkpoint🙂".repeat(5000);
  let seenPrior = "", calls = 0;
  const stream = async (_model, ctx, options) => ({ result: async () => {
    const text = ctx.messages.find(message => message.role === "user").content[0].text;
    assert.ok(Buffer.byteLength(text) <= (model.contextWindow - options.maxTokens - 8192) / 2);
    assert.match(text, /Additional focus: preserve release custody/);
    const segment = text.match(/<previous-summary>\n([\s\S]*?)\n<\/previous-summary>/)?.[1];
    if (segment !== undefined) seenPrior += segment.replace(/^\[Reduced preceding summary segments\]:\ncheckpoint\n\n/, "");
    else {
      assert.equal(seenPrior, prior);
      assert.match(text, /newly accepted task/);
    }
    calls++;
    return response();
  } });
  const result = await generateSummaryWithUsage([{ role: "user", content: "newly accepted task", timestamp: 1 }], model, 1280, "fixture", undefined, undefined, "preserve release custody", prior, "max", stream);
  assert.equal(seenPrior, prior);
  assert.equal(result.text, "checkpoint");
  assert.equal(result.usage.totalTokens, calls * 12);
  assert.ok(calls > 2);
});

test("deployment patches both source forms idempotently and preserves valid syntax", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-summary-patch-"));
  const target = join(root, "@earendil-works/pi-coding-agent/dist");
  try {
    for (const path of new Set([...summaries, ...sessions])) {
      const destination = join(target, relative(base, path));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(path, destination);
    }
    patchSummaryRecoveryCopies(root);
    patchSummaryRecoveryCopies(root);
    for (const path of new Set([...summaries, ...sessions])) execFileSync(process.execPath, ["--check", join(target, relative(base, path))], { timeout: 5000 });
    for (const path of summaries) assert.match(readFileSync(join(target, relative(base, path)), "utf8"), /Pi Stack bounded summary recovery/);
    for (const path of sessions) assert.match(readFileSync(join(target, relative(base, path)), "utf8"), /Pi Stack durable summary failure fence/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
