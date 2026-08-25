import test from "node:test";
import assert from "node:assert/strict";
import stateCompactor, { COMPACT_THRESHOLD_TOKENS } from "./index.mjs";

test("guards provider requests with one native compaction at 250,000 tokens", () => {
  const handlers = new Map();
  stateCompactor({
    on(event, handler) {
      handlers.set(event, handler);
    },
  });

  assert.deepEqual([...handlers.keys()], ["before_provider_request"]);

  let tokens = null;
  const compactions = [];
  const ctx = {
    getContextUsage: () => ({ tokens }),
    compact: (options) => compactions.push(options),
  };
  const guard = handlers.get("before_provider_request");

  guard({}, ctx);
  tokens = COMPACT_THRESHOLD_TOKENS - 1;
  guard({}, ctx);
  assert.equal(compactions.length, 0);

  tokens = COMPACT_THRESHOLD_TOKENS;
  guard({}, ctx);
  guard({}, ctx);
  assert.equal(compactions.length, 1);

  compactions[0].onError(new Error("failed"));
  guard({}, ctx);
  assert.equal(compactions.length, 2);

  compactions[1].onComplete({});
  guard({}, ctx);
  assert.equal(compactions.length, 3);
});
