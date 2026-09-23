import assert from "node:assert/strict";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { SessionManager, buildSessionContext } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import codexCompaction, { checkpointContext, checkpointSummary, createCheckpoint } from "./index.mjs";
import { KIND, VERSION, compactionObserver, findCheckpoint, modelKey, replaceMarker, retainRecentUsers } from "./native.mjs";

const model = { api: "openai-codex-responses", provider: "openai-codex-2", id: "gpt-5.6-luna", name: "Luna", baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text", "image"], contextWindow: 272000, maxTokens: 32768, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } };
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const token = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.c`;
const item = { type: "compaction", id: "cp_fixture", encrypted_content: "encrypted-fixture" };
const sse = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
const completed = (checkpoint = item) => [
  { type: "response.output_item.done", output_index: 0, item: checkpoint },
  { type: "response.completed", response: { id: "resp_compacted", status: "completed", output: [checkpoint], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 30 } } } },
];

function fixture() {
  const sm = SessionManager.inMemory();
  const first = sm.appendMessage({ role: "user", content: "Remember the cobalt key", timestamp: 1 });
  sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "facts" } }, { type: "toolCall", id: "call_2|fc_2", name: "read", arguments: { path: "other" } }], api: model.api, provider: model.provider, model: model.id, usage: zero, stopReason: "toolUse", timestamp: 2 });
  for (let n = 1; n <= 2; n++) sm.appendMessage({ role: "toolResult", toolCallId: `call_${n}|fc_${n}`, toolName: "read", content: [{ type: "text", text: `result ${n}` }], isError: false, timestamp: 2 + n });
  const handlers = new Map();
  const notifications = [];
  let aborted = false;
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    appendEntry: (type, data) => sm.appendCustomEntry(type, data),
    events: { emit() {} }, getThinkingLevel: () => "high", getActiveTools: () => ["read"],
    getAllTools: () => [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
  };
  const ctx = {
    model, sessionManager: sm, getSystemPrompt: () => "Fixture system text", abort() { aborted = true; },
    ui: { notify: (...args) => notifications.push(args) },
    modelRegistry: { complete: (requestModel, context, options) => stream(requestModel, normalizeContext(context), { apiKey: token, ...options }).result() },
  };
  const event = { branchEntries: sm.getBranch(), preparation: { firstKeptEntryId: first, tokensBefore: 100 }, reason: "threshold", willRetry: false, signal: new AbortController().signal };
  return { pi, ctx, sm, first, handlers, notifications, event, get aborted() { return aborted; } };
}

for (const reason of ["manual", "threshold", "overflow"]) test(`${reason} uses Pi's actual serializer, transport, tools and usage`, async () => {
  const f = fixture();
  let requests = 0;
  const result = await createCheckpoint(f.pi, f.ctx, { ...f.event, reason, willRetry: reason === "overflow" }, async (url, options) => {
    requests++;
    assert.match(String(url), /\/codex\/responses$/u);
    assert.match(options.headers.get("x-codex-beta-features"), /remote_compaction_v2/u);
    assert.equal(options.headers.get("chatgpt-account-id"), "fixture-account");
    const body = JSON.parse(options.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(options.body).toString() : options.body);
    assert.equal(body.instructions, "Fixture system text");
    assert.equal(body.tools[0].name, "read");
    assert.equal(body.input.at(-1).type, "compaction_trigger");
    assert.equal(body.input.filter(item => item.type === "function_call").length, 2);
    assert.equal(body.input.filter(item => item.type === "function_call_output").length, 2);
    assert.equal(body.store, false);
    return new Response(sse(completed()), { headers: { "content-type": "text/event-stream" } });
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(requests, 1);
  assert.equal(result.value.modelKey, modelKey(model));
  assert.deepEqual(result.value.replacementHistory.at(-1), item);
  assert.equal(result.usage.input, 70);
  assert.equal(result.usage.cacheRead, 30);
  assert.equal(result.usage.totalTokens, 110);
});

test("persisted checkpoint replay preserves live context, aliases, repeated compaction and branch selection", async () => {
  const f = fixture();
  const details = { kind: KIND, version: VERSION, modelKey: modelKey(model), replacementHistory: [{ role: "user", content: "Remember the cobalt key" }, item] };
  const summary = checkpointSummary(model, "/session.jsonl");
  f.sm.appendCompaction(summary, f.first, 100, details, true, zero);
  const checkpointBranch = JSON.parse(JSON.stringify(f.sm.getBranch()));
  f.sm.appendMessage({ role: "user", content: "After checkpoint", timestamp: 5 });
  const branch = f.sm.getBranch();
  const live = [...buildSessionContext(branch).messages, { role: "user", content: "Queued but not persisted yet", timestamp: 6 }];
  const context = checkpointContext(live, branch, { ...model, provider: "openai-codex-9" });
  assert.equal(context.ok, true, context.error);
  assert.deepEqual(context.value.messages.map(message => message.content), [context.value.marker, "After checkpoint", "Queued but not persisted yet"]);
  const payload = { input: context.value.messages.map(message => ({ role: "user", content: [{ type: "input_text", text: message.content }] })), tools: ["untouched"], previous_response_id: "removed" };
  const rewritten = replaceMarker(payload, context.value.marker, details.replacementHistory);
  assert.equal(rewritten.ok, true);
  assert.equal(rewritten.value.input.filter(item => item.type === "compaction").length, 1);
  assert.equal(rewritten.value.input.at(-1).content[0].text, "Queued but not persisted yet");
  assert.deepEqual(rewritten.value.tools, ["untouched"]);
  assert.equal(rewritten.value.previous_response_id, undefined);
  assert.equal(checkpointContext(buildSessionContext(checkpointBranch).messages, checkpointBranch, model).ok, true);

  let sent;
  const next = await createCheckpoint(f.pi, f.ctx, { ...f.event, branchEntries: branch }, async (_url, options) => {
    sent = JSON.parse(zstdDecompressSync(options.body).toString());
    return new Response(sse(completed({ ...item, id: "cp_next", encrypted_content: "next" })));
  });
  assert.equal(next.ok, true, next.error);
  assert.equal(sent.input.filter(item => item.type === "compaction").length, 1);
  assert.equal(sent.input.filter(item => item.type === "function_call_output").length, 0);
  assert.equal(next.value.replacementHistory.filter(item => item.type === "compaction").length, 1);
  f.sm.branch(f.first);
  assert.equal(findCheckpoint(f.sm.getBranch()).value, undefined);
});

test("another model receives the factual history notice and retained tail instead of losing both", () => {
  const f = fixture();
  f.sm.appendCompaction(checkpointSummary(model, "/session.jsonl"), f.first, 100, { kind: KIND, version: VERSION, modelKey: modelKey(model), replacementHistory: [item] });
  for (const target of [{ ...model, id: "gpt-6-astra" }, { ...model, api: "anthropic-messages" }]) {
    const messages = buildSessionContext(f.sm.getBranch()).messages;
    const result = checkpointContext(messages, f.sm.getBranch(), target);
    assert.equal(result.ok, true);
    assert.equal(result.value.messages, messages);
    assert.match(messages[0].summary, /different model receives the retained messages/u);
    assert.match(messages[0].summary, /\/session.jsonl/u);
    assert.equal(messages.at(-1).role, "toolResult");
  }
});

test("SSE observation handles split bytes, terminal-only output and rejects incomplete streams", async () => {
  for (const events of [completed(), [completed()[1]]]) {
    const observer = compactionObserver();
    const text = sse(events).replaceAll("\n", "\r\n");
    const bytes = new TextEncoder().encode(text);
    const response = observer.wrap(new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } })));
    assert.equal(await response.text(), text);
    assert.deepEqual(observer.result(), { ok: true, value: item });
  }
  for (const events of [[completed()[0]], [{ type: "response.incomplete" }], [...completed(), { type: "response.output_item.done", item: { ...item, encrypted_content: "other" } }]]) {
    const observer = compactionObserver();
    await observer.wrap(new Response(sse(events))).text();
    assert.equal(observer.result().ok, false);
  }
});

test("malformed checkpoints and missing payload markers abort rather than leaking reduced context", async t => {
  const diagnostic = t.mock.method(console, "error", () => {});
  const f = fixture();
  codexCompaction(f.pi);
  f.sm.appendCompaction("checkpoint", f.first, 100, { kind: KIND, version: VERSION, modelKey: modelKey(model), replacementHistory: [item] });
  f.handlers.get("before_provider_request")({ payload: { input: [] } }, f.ctx);
  assert.equal(f.aborted, true);
  assert.match(f.notifications[0][0], /removed or duplicated/u);
  assert.equal(JSON.parse(diagnostic.mock.calls[0].arguments[0]).phase, "request-blocked");
  f.sm.appendCompaction("broken", f.first, 100, { kind: KIND, version: VERSION, replacementHistory: [] });
  assert.equal(findCheckpoint(f.sm.getBranch()).ok, false);
  assert.equal(checkpointContext(buildSessionContext(f.sm.getBranch()).messages, f.sm.getBranch(), model).ok, false);
});

test("failed native compaction retains context and fences automatic retries across reload and aliases", async t => {
  const diagnostic = t.mock.method(console, "error", () => {});
  const f = fixture();
  codexCompaction(f.pi);
  const before = JSON.stringify(buildSessionContext(f.sm.getBranch()).messages);
  f.ctx.modelRegistry.complete = async () => ({ stopReason: "error", errorMessage: "401 token expired", usage: zero });
  let calls = 0;
  f.ctx.modelRegistry.complete = async () => { calls++; return { stopReason: "error", errorMessage: "401 token expired", usage: zero }; };
  const result = await f.handlers.get("session_before_compact")(f.event, f.ctx);
  assert.equal(result.cancel, undefined);
  assert.match(result.error, /401 token expired/);
  assert.equal(JSON.stringify(buildSessionContext(f.sm.getBranch()).messages), before);
  assert.match(f.notifications[0][0], /401 token expired/u);
  const record = JSON.parse(diagnostic.mock.calls[0].arguments[0]);
  assert.equal(record.phase, "compaction-failed");
  assert.equal(record.error, "401 token expired");
  assert.equal(record.reason, "threshold");
  assert.equal(record.provider, model.provider);
  f.ctx.ui.notify = () => {};
  codexCompaction(f.pi);
  f.ctx.model = { ...model, provider: "openai-codex-9" };
  for (let i = 0; i < 32; i++) {
    const retry = await f.handlers.get("session_before_compact")({ ...f.event, branchEntries: f.sm.getBranch() }, f.ctx);
    assert.match(retry.error, /Automatic resubmission is blocked/);
  }
  assert.equal(calls, 1);
  const rejected = f.handlers.get("context")({ messages: buildSessionContext(f.sm.getBranch()).messages }, f.ctx);
  assert.match(rejected.error, /401 token expired/);
  assert.equal(f.aborted, false);
  await f.handlers.get("session_before_compact")({ ...f.event, branchEntries: f.sm.getBranch(), reason: "manual" }, f.ctx);
  assert.equal(calls, 2);
  assert.equal(f.handlers.has("turn_end"), false);
  assert.equal(f.handlers.has("agent_settled"), false);
});

for (const stopReason of ["error", "aborted"]) test(`overflow excludes ${stopReason} terminal content through Pi's serializer`, async () => {
  const f = fixture();
  f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "terminal-content-must-not-replay" }, { type: "toolCall", id: "unfinished", name: "read", arguments: { path: "never-executed" } }], api: model.api, provider: model.provider, model: model.id, usage: zero, stopReason, timestamp: 5 });
  const result = await createCheckpoint(f.pi, f.ctx, { ...f.event, branchEntries: f.sm.getBranch(), reason: "overflow", willRetry: true }, async (_url, options) => {
    const text = options.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(options.body).toString() : options.body;
    assert.doesNotMatch(text, /terminal-content-must-not-replay|never-executed|unfinished/u);
    assert.equal(JSON.parse(text).input.filter(item => item.type === "function_call_output").length, 2);
    return new Response(sse(completed()));
  });
  assert.equal(result.ok, true, result.error);
});

test("a checkpoint item without terminal completion times out, cancels the reader and cannot commit", async () => {
  const f = fixture();
  let cancelled = false;
  const result = await createCheckpoint(f.pi, f.ctx, f.event, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(sse([completed()[0]]))); },
    cancel() { cancelled = true; },
  })), { idleMs: 10, deadlineMs: 1000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /idle-timeout in stream/);
  assert.equal(result.diagnostic.lastEvent, "response.output_item.done");
  assert.equal(result.diagnostic.abortCause, "idle-timeout");
  assert.equal(cancelled, true);
  assert.equal(f.sm.getBranch().some(entry => entry.type === "compaction"), false);
});

test("retention bounds user text without retaining assistant output", () => {
  const retained = retainRecentUsers([{ role: "user", content: "a".repeat(100) }, { role: "assistant", content: "omit" }, { role: "user", content: "recent" }], 5);
  assert.equal(retained.at(-1).content, "recent");
  assert.ok(retained.reduce((sum, item) => sum + item.content.length, 0) <= 20);
});
