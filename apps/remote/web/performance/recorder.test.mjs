import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { matrixSteps } from "./matrix.mjs";
import { summarize } from "./summarize.mjs";

function recorder(entries = []) {
  const context = {
    window: { fetch: async () => ({ status: 200 }) },
    document: { querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} },
    location: { origin: "http://localhost:1234" },
    performance: { now: () => 0, getEntriesByType: type => type === "resource" ? entries : [] },
    PerformanceObserver: class { static supportedEntryTypes = []; },
    MutationObserver: class { disconnect() {} },
    Request, URL, setTimeout, clearTimeout, cancelAnimationFrame() {},
  };
  vm.runInNewContext(readFileSync(new URL("recorder.js", import.meta.url), "utf8"), context);
  return context.window.piClientTiming;
}

test("observations cannot persist URL credentials, queries, unknown paths or payloads", () => {
  const api = recorder([
    { name: "http://username:password@localhost:1234/v1/sessions/private-thread/items/private-item?key=secret", initiatorType: "fetch", startTime: 1, duration: 4, requestStart: 2, responseStart: 3, responseEnd: 5, transferSize: 6, encodedBodySize: 7, decodedBodySize: 8, responseStatus: 200, privateBody: "payload" },
    { name: "http://localhost:1234/v1/files/PrivateFolder/PrivateFile?path=/secret.txt", initiatorType: "fetch" },
    { name: "https://external.example/private?token=secret", initiatorType: "img" },
  ]);
  const data = api.navigation();
  assert.deepEqual(Array.from(data.resources, value => value.route), ["/v1/sessions/:id/items/:id", "/v1/files/:id/:id", ":external"]);
  assert.doesNotMatch(JSON.stringify(data), /username|password|secret|Private|private-thread|private-item|payload|external\.example/);
});

test("unset specs, missing input and overlapping measurements are explicit errors", async () => {
  const api = recorder();
  assert.equal(api.arm(undefined).error, "invalid-spec");
  assert.equal((await api.take()).state, "no-measurement");
  const spec = { name: "synthetic", cache: "cold", trigger: "button", scope: "#app", ready: ".ready", absent: null, loading: null, quietMs: 100, timeoutMs: 1000 };
  assert.equal(api.arm(spec).ok, true);
  assert.equal((await api.take()).state, "not-triggered");
  assert.equal(api.arm(spec).error, "measurement-active");
  assert.equal(api.dispose().state, "disposed");
});

test("historical samples without an input kind stay unset", () => {
  const row = { name: "synthetic", cache: "warm", state: "settled", observationMs: 2, firstRenderMs: 1, usableMs: 1, settledMs: 2, longTasks: { totalMs: 0 }, frames: { maxGapMs: 1 }, requests: [], resources: [] };
  const result = summarize([[{ result: { result: row } }, { result: { result: row } }]]);
  assert.equal(result[0].samples, 1);
  assert.deepEqual(result[0].triggerEvents, [null]);
});

test("native matrix rejects unknown coverage and verifies page target around eval", () => {
  assert.equal(matrixSteps({ cache: "warm", rounds: 1, names: ["unknown", "chats-nav"], quietMs: 100, timeoutMs: 1000 }).error, "unknown-case");
  const result = matrixSteps({ cache: "warm", rounds: 1, names: ["chats-nav", "files-nav"], quietMs: 100, timeoutMs: 1000 });
  assert.equal(result.ok, true);
  const arm = result.steps.findIndex(step => step[0] === "eval" && step[1].startsWith("piArmCase("));
  assert.deepEqual(result.steps[arm - 1], ["get", "url"]);
  assert.deepEqual(result.steps[arm + 1], ["get", "url"]);
  assert.equal(result.steps[arm + 2][0], "click");
});
