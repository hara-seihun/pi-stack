import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateModels, summarizeWithRuntime } from "./runtime.mjs";

const models = [
  { provider: "account-b", id: "gpt-6-astra" },
  { provider: "account-a", id: "gpt-6-astra" },
  { provider: "other", id: "other-model" },
];

function fakeRuntime(complete) {
  return {
    getModels: (provider) => provider ? models.filter((model) => model.provider === provider) : models,
    getModel: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    getAvailable: async (provider) => models.filter(
      (model) => model.provider !== "other" && (provider === undefined || model.provider === provider),
    ),
    complete,
  };
}

test("candidate selection awaits availability and honors preferred and pinned providers", async () => {
  const runtime = fakeRuntime();
  assert.deepEqual((await candidateModels(runtime, { model: "gpt-6-astra", preferredProvider: "account-b" })).map((model) => model.provider), ["account-b", "account-a"]);
  assert.deepEqual((await candidateModels(runtime, { model: "account-a/gpt-6-astra" })).map((model) => model.provider), ["account-a"]);
  await assert.rejects(candidateModels(runtime, { model: "missing/gpt-6-astra" }), /has no model/);
});

test("direct summarization sends exactly one user message and no agent context", async () => {
  let request;
  const runtime = fakeRuntime(async (model, context, options) => {
    request = { model, context, options };
    return { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "  summary text  " }], stopReason: "stop" };
  });
  const result = await summarizeWithRuntime(runtime, "PROMPT", {
    model: "account-a/gpt-6-astra", thinking: "medium", timeoutMs: 10_000,
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
  assert.equal(result.model, "account-a/gpt-6-astra");
});

test("a failed provider falls through to the next alias", async () => {
  const called = [];
  const runtime = fakeRuntime(async (model) => {
    called.push(model.provider);
    if (model.provider === "account-a") throw new Error("usage exhausted");
    return { role: "assistant", content: [{ type: "text", text: "fallback summary" }], stopReason: "stop" };
  });
  const result = await summarizeWithRuntime(runtime, "PROMPT", {
    model: "gpt-6-astra", preferredProvider: "account-a", timeoutMs: 10_000,
  });
  assert.deepEqual(called, ["account-a", "account-b"]);
  assert.equal(result.model, "account-b/gpt-6-astra");
});

test("all provider errors are reported together", async () => {
  const runtime = fakeRuntime(async (model) => {
    throw new Error(`${model.provider} down`);
  });
  await assert.rejects(
    summarizeWithRuntime(runtime, "PROMPT", { model: "gpt-6-astra", timeoutMs: 10_000 }),
    /account-a: account-a down; account-b: account-b down/,
  );
});
