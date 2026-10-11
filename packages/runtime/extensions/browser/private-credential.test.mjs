import assert from "node:assert/strict";
import { test } from "node:test";
import { compilePrivateCredential, installPrivateCredentialMode } from "./private-credential.mjs";
import { installBrowserEffectFence } from "./effects.mjs";

const credential = { provider: "proton-pass", item: "Synthetic Card", field: "number", selector: "input[autocomplete=cc-number]", target: "synthetic-target", frame: "synthetic-frame" };
const declaration = { intentKey: "fixture:private-fill", recipients: ["account:synthetic"] };

function fixture() {
  const calls = [];
  const tool = { description: "fixture", parameters: { type: "object", properties: {} }, execute: async (...args) => { calls.push(args); return { content: [], details: { filled: true } }; } };
  installPrivateCredentialMode(tool);
  return { tool, calls };
}

test("private mode compiles references only, preserving session budget, declaration and callback identity", async () => {
  const { tool, calls } = fixture();
  const signal = new AbortController().signal, update = () => {}, ctx = {};
  const result = await tool.execute("fixture", { privateCredential: credential, timeoutMs: 240000, externalAction: declaration }, signal, update, ctx);
  assert.equal(result.details.filled, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["fixture", { args: ["auth", "fill", "--credential-provider", "proton-pass", "--item", "Synthetic Card", "--field", "number", "--selector", "input[autocomplete=cc-number]", "--target", "synthetic-target", "--frame", "synthetic-frame"], timeoutMs: 240000, externalAction: declaration }, signal, update, ctx]);
  assert.equal(tool.parameters.properties.privateCredential.additionalProperties, false);
  assert.deepEqual(tool.parameters.properties.privateCredential.required, ["provider", "item", "field", "selector", "target", "frame"]);
});

test("invalid private fills never dispatch or echo supplied secrets", async () => {
  const { tool, calls } = fixture();
  const secret = "synthetic-secret-do-not-echo";
  const cases = [null, [], {}, ...["provider", "item", "field", "selector", "target", "frame"].map(key => ({ ...credential, [key]: "" })),
    { ...credential, field: "unknown" }, { ...credential, value: secret }, { ...credential, format: "unknown" }, { ...credential, format: "mm/yy" }, { ...credential, target: "x\0y" }];
  for (const privateCredential of cases) {
    const result = await tool.execute("invalid", { privateCredential });
    assert.equal(result.isError, true);
    assert.equal(result.details.code, "private_credential_invalid");
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  for (const params of [{ args: ["snapshot"] }, { script: secret }, { semanticAction: {} }, { job: {} }, { qa: {} }, { electron: {} }, { sourceLookup: {} }, { networkSourceLookup: {} }, { stdin: secret }, { sessionMode: "fresh" }]) {
    assert.equal((await tool.execute("conflict", { privateCredential: credential, ...params })).isError, true);
  }
  assert.equal(calls.length, 0);
});

test("main frame and explicit expiration format compile; raw args remain unchanged", async () => {
  const compiled = compilePrivateCredential({ privateCredential: { ...credential, frame: "main", field: "expiration_date", format: "mm/yy" } });
  assert.equal(compiled.ok, true);
  assert.deepEqual(compiled.input.args.slice(-4), ["--frame", "main", "--format", "mm/yy"]);
  const { tool, calls } = fixture();
  const raw = { args: ["auth", "fill", "--item", "Synthetic Card"] };
  await tool.execute("raw", raw);
  assert.equal(calls[0][1], raw);
});

test("compiled private fill enters the same canonical fence; uncertain retry cannot re-dispatch", async () => {
  const stages = [], native = [];
  let state = "accepted";
  const tool = { description: "fixture", parameters: { type: "object", properties: {} }, execute: async (_id, params) => { native.push(params); return { content: [], details: { filled: true } }; } };
  const authority = {
    submit: async params => { stages.push(["submit", params]); return { ok: true, value: { action: { id: "fixture-action", state } } }; },
    claim: async () => ({ ok: true, value: { id: "fixture-action" } }),
    dispatch: async () => { stages.push(["dispatch"]); return { ok: true }; },
    finish: async (_ticket, next) => { state = next; return { ok: true, value: { state } }; },
  };
  installBrowserEffectFence(tool, { loadContract: async () => ({ extractUpstreamCommandTokens: args => args }), createAuthority: async () => authority, env: { PI_THREAD_ID: "fixture-thread" } });
  installPrivateCredentialMode(tool);
  const params = { privateCredential: credential, externalAction: declaration };
  assert.equal((await tool.execute("first", params)).details.externalAction.state, "uncertain");
  assert.equal((await tool.execute("retry", params)).details.externalAction.dispatched, false);
  assert.equal(native.length, 1);
  assert.equal(stages.filter(([stage]) => stage === "dispatch").length, 1);
  assert.equal(native[0].privateCredential, undefined);
  assert.equal(native[0].externalAction, undefined);
  assert.deepEqual(stages[0][1].payload, stages[2][1].payload);
});
