import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ACTIVITY_LIMIT,
  FIRST_LOOKBACK_MS,
  registerScratchUpdates,
  runScratchUpdates,
} from "./index.mjs";

const NOW = Date.parse("2026-08-30T02:00:00.000Z");

function activity(at, overrides = {}) {
  return {
    kind: "formulation_settled",
    at,
    actor_name: "Researcher",
    problem_id: "problem-id",
    problem_title: "A problem",
    formulation_id: "formulation-id",
    formulation_title: "The exact statement",
    detail: "The completion criterion now has a proof.",
    outcome: "proved",
    source: "internal",
    object_id: overrides.object_id ?? `event-${at}`,
    ...overrides,
  };
}

function successfulExec(items) {
  return async (command, args, options) => {
    assert.equal(command, "mcp");
    assert.deepEqual(args, ["call", "math_scratch_recent_activity", JSON.stringify({ limit: ACTIVITY_LIMIT })]);
    assert.equal(options.timeout, 10_000);
    return {
      code: 0,
      stdout: JSON.stringify({ structuredContent: { items, generated_at: new Date(NOW).toISOString() } }),
      stderr: "",
    };
  };
}

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "scratch-updates-test-"));
  const statePath = join(directory, "state.json");
  try {
    await run(statePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the first invocation looks back one hour and advances to invocation start", () => fixture(async (statePath) => {
  const included = activity("2026-08-30T01:30:00.000Z");
  const excluded = activity("2026-08-30T00:59:59.999Z");
  const result = await runScratchUpdates({
    exec: successfulExec([included, excluded]),
    statePath,
    now: () => NOW,
  });

  assert.equal(result.details.since, new Date(NOW - FIRST_LOOKBACK_MS).toISOString());
  assert.deepEqual(result.details.items, [included]);
  assert.match(result.text, /Scratch activity after 2026-08-30T01:00:00\.000Z/);
  assert.match(result.text, /formulation settled: The exact statement/);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(state, { version: 1, lastInvokedAt: "2026-08-30T02:00:00.000Z" });
}));

test("later invocations use the shared persisted checkpoint", () => fixture(async (statePath) => {
  await runScratchUpdates({ exec: successfulExec([]), statePath, now: () => NOW });
  const later = NOW + 30 * 60 * 1000;
  const result = await runScratchUpdates({
    exec: successfulExec([
      activity("2026-08-30T02:10:00.000Z"),
      activity("2026-08-30T01:59:59.000Z"),
    ]),
    statePath,
    now: () => later,
  });

  assert.equal(result.details.since, "2026-08-30T02:00:00.000Z");
  assert.equal(result.details.count, 1);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).lastInvokedAt, "2026-08-30T02:30:00.000Z");
}));

test("a saturated feed that does not reach the checkpoint stays explicitly partial", () => fixture(async (statePath) => {
  const items = Array.from({ length: ACTIVITY_LIMIT }, (_, index) =>
    activity(new Date(NOW - index * 1000).toISOString(), { object_id: `event-${index}` }));
  const result = await runScratchUpdates({ exec: successfulExec(items), statePath, now: () => NOW });

  assert.equal(result.details.incomplete, true);
  assert.match(result.text, /Partial scratch activity/);
  await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
}));

test("an MCP failure does not advance the checkpoint", () => fixture(async (statePath) => {
  await assert.rejects(
    runScratchUpdates({
      exec: async () => ({ code: 1, stdout: "", stderr: "connection refused" }),
      statePath,
      now: () => NOW,
    }),
    /Could not read the math scratch activity feed: connection refused/,
  );
  await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
}));

test("the extension registers a parameter-free model tool", () => {
  let registered;
  registerScratchUpdates({ registerTool: (tool) => { registered = tool; } }, {
    statePath: "/tmp/unused-scratch-update-state",
    now: () => NOW,
  });
  assert.equal(registered.name, "scratch_updates");
  assert.deepEqual(registered.parameters.properties, {});
  assert.equal(registered.parameters.required, undefined);
  assert.equal(registered.parameters.additionalProperties, false);
  assert.match(registered.description, /first invocation looks back one hour/i);
});
