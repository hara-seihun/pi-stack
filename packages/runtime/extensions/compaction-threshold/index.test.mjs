import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import extension, { COMPACT_THRESHOLDS, CONTINUATION_MESSAGE, thresholdForModel } from "./index.mjs";

function harness(tokens, modelId = "gpt-5.6-sol") {
  let listener;
  let options;
  const messages = [];
  const pi = {
    on(name, fn) {
      assert.equal(name, "before_provider_request");
      listener = fn;
    },
    sendMessage(message, delivery) {
      messages.push({ message, delivery });
    },
  };
  extension(pi);
  const ctx = {
    model: { id: modelId },
    getContextUsage: () => ({ tokens }),
    compact(value) {
      options = value;
    },
  };
  return { fire: () => listener({}, ctx), options: () => options, messages };
}

for (const [modelId, threshold] of [
  ["gpt-5.6-sol", 250_000],
  ["claude-fable-5-1", 500_000],
  ["claude-opus-5", 500_000],
  ["claude-opus-4-8", 500_000],
]) {
  test(`${modelId} compacts at ${threshold.toLocaleString()} tokens`, () => {
    assert.equal(thresholdForModel(modelId), threshold);
    const below = harness(threshold - 1, modelId);
    below.fire();
    assert.equal(below.options(), undefined);
    const at = harness(threshold, modelId);
    at.fire();
    assert.ok(at.options());
  });
}

test("unlisted models retain the 250,000-token threshold", () => {
  assert.equal(thresholdForModel("claude-sonnet-5"), COMPACT_THRESHOLDS.default);
});

test("one compaction runs at a time and resumes the interrupted task", () => {
  const run = harness(COMPACT_THRESHOLDS.sol);
  run.fire();
  const first = run.options();
  run.fire();
  assert.equal(run.options(), first);
  first.onComplete();
  assert.deepEqual(run.messages, [{
    message: { customType: "compaction-threshold", content: CONTINUATION_MESSAGE, display: false },
    delivery: { triggerTurn: true },
  }]);
  run.fire();
  assert.notEqual(run.options(), first);
});

test("a failed compaction may be retried", () => {
  const run = harness(COMPACT_THRESHOLDS.sol);
  run.fire();
  const first = run.options();
  first.onError();
  run.fire();
  assert.notEqual(run.options(), first);
});

test("only the local threshold trigger resumes automatic compaction", () => {
  const deploy = readFileSync(new URL("../../../../deploy/settings", import.meta.url), "utf8");
  assert.match(deploy, /"continueAfterThresholdCompact": false/);
});
