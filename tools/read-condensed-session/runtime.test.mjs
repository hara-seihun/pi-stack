import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateModels, summarizeWithRuntime } from "./runtime.mjs";

const models = [
  { provider: "account-b", id: "gpt-5.6-sol" },
  { provider: "account-a", id: "gpt-5.6-sol" },
  { provider: "other", id: "other-model" },
];

function fakeRuntime(complete) {
  return {
    getModels: () => models,
    getModel: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    hasConfiguredAuth: (provider) => provider !== "other",
    complete,
  };
}

test("candidate selection honors preferred and explicitly pinned providers", () => {
  const runtime = fakeRuntime();
  assert.deepEqual(candidateModels(runtime, { model: "gpt-5.6-sol", preferredProvider: "account-b" }).map((model) => model.provider), ["account-b", "account-a"]);
  assert.deepEqual(candidateModels(runtime, { model: "account-a/gpt-5.6-sol" }).map((model) => model.provider), ["account-a"]);
  assert.throws(() => candidateModels(runtime, { model: "missing/gpt-5.6-sol" }), /has no model/);
});

test("direct summarization sends exactly one user message and no agent context", async () => {
  let request;
  const runtime = fakeRuntime(async (model, context, options) => {
    request = { model, context, options };
    return { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "  summary text  " }], stopReason: "stop" };
  });
  const result = await summarizeWithRuntime(runtime, "PROMPT", {
    model: "account-a/gpt-5.6-sol", thinking: "medium", timeoutMs: 10_000,
  });
  assert.deepEqual(request.context, {
    messages: [{ role: "user", content: [{ type: "text", text: "PROMPT" }], timestamp: request.context.messages[0].timestamp }],
  });
  assert.equal(typeof request.context.messages[0].timestamp, "number");
  assert.equal(request.options.reasoningEffort, "medium");
  assert.equal(request.options.maxTokens, 2_000);
  assert.equal(request.options.cacheRetention, "none");
  assert.equal(typeof request.options.sessionId, "string");
  assert.equal(result.text, "summary text");
  assert.equal(result.model, "account-a/gpt-5.6-sol");
});

test("a failed provider falls through to the next alias", async () => {
  const called = [];
  const runtime = fakeRuntime(async (model) => {
    called.push(model.provider);
    if (model.provider === "account-a") throw new Error("usage exhausted");
    return { role: "assistant", content: [{ type: "text", text: "fallback summary" }], stopReason: "stop" };
  });
  const result = await summarizeWithRuntime(runtime, "PROMPT", {
    model: "gpt-5.6-sol", preferredProvider: "account-a", timeoutMs: 10_000,
  });
  assert.deepEqual(called, ["account-a", "account-b"]);
  assert.equal(result.model, "account-b/gpt-5.6-sol");
});

test("all provider errors are reported together", async () => {
  const runtime = fakeRuntime(async (model) => {
    throw new Error(`${model.provider} down`);
  });
  await assert.rejects(
    summarizeWithRuntime(runtime, "PROMPT", { model: "gpt-5.6-sol", timeoutMs: 10_000 }),
    /account-a: account-a down; account-b: account-b down/,
  );
});
