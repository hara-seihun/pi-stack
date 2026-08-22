import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  alertBody,
  alertTitle,
  alreadyPending,
  DEFAULT_THRESHOLD_KB,
  measureMcpResponse,
  redactArguments,
  registerGuard,
  thresholdBytes,
} from "./index.mjs";

const gatewayCall = (bytes) => ({
  mode: "call",
  server: "math",
  tool: "review_queue",
  outputGuard: { truncated: true, originalBytes: bytes, returnedBytes: 50_000, fullOutputPath: "/tmp/x/output.txt" },
});

test("measures the response the guard already sized, by either route", () => {
  assert.equal(measureMcpResponse(gatewayCall(13_480_985)).bytes, 13_480_985);
  assert.equal(
    measureMcpResponse({ server: "math", tool: "get", mcpResult: { omitted: true, rawResultBytes: 2_000_000 } }).bytes,
    2_000_000,
  );
  // Text and raw JSON are two measurements of one response; the wire carried the larger.
  assert.equal(
    measureMcpResponse({
      server: "math",
      tool: "get",
      outputGuard: { originalBytes: 10 },
      mcpResult: { rawResultBytes: 900 },
    }).bytes,
    900,
  );
});

test("only a response attributable to a server and tool is measured", () => {
  assert.equal(measureMcpResponse(undefined), null);
  assert.equal(measureMcpResponse({ outputGuard: { originalBytes: 9_000_000 } }), null);
  // An mcpScript result is a batch whose emitted output the agent chose; the
  // adapter reports no server for it and no server means nobody to alert about.
  assert.equal(measureMcpResponse({ mode: "script", calls: [], outputGuard: { originalBytes: 9_000_000 } }), null);
  // A result the guard never had to touch has no size to report, and is small.
  assert.equal(measureMcpResponse({ server: "math", tool: "hello", mcpResult: { ok: true } }), null);
});

test("a resource read is named by its URI", () => {
  const measured = measureMcpResponse({
    server: "math",
    resourceUri: "ledger://overview",
    outputGuard: { originalBytes: 5_000_000 },
  });
  assert.equal(measured.tool, "ledger://overview");
  assert.equal(measured.key, "mcp-oversize math/ledger://overview");
});

test("the threshold is a kilobyte knob with a defensible default", () => {
  assert.equal(thresholdBytes({}), DEFAULT_THRESHOLD_KB * 1024);
  assert.equal(thresholdBytes({ PI_MCP_SIZE_ALERT_KB: "256" }), 256 * 1024);
  assert.equal(thresholdBytes({ PI_MCP_SIZE_ALERT_KB: "nonsense" }), DEFAULT_THRESHOLD_KB * 1024);
  assert.equal(thresholdBytes({ PI_MCP_SIZE_ALERT_KB: "-5" }), DEFAULT_THRESHOLD_KB * 1024);
});

test("credentials in tool arguments never reach a durable file", () => {
  assert.match(redactArguments({ query: "x", api_key: "sk-live-1234" }), /"api_key":"\[redacted\]"/);
  assert.doesNotMatch(redactArguments({ contributor_key: "mrk_secret" }), /mrk_secret/);
  assert.equal(redactArguments(undefined), "(none)");
});

test("an unconsumed alert for the same tool silences repeats", () => {
  const measured = measureMcpResponse(gatewayCall(9_000_000));
  const filed = alertBody(measured, { input: {}, cwd: "/home/kenan", limit: 1024 * 1024 });
  assert.ok(alreadyPending([filed], measured.key));
  assert.ok(!alreadyPending([filed], "mcp-oversize math/search"));
  assert.ok(!alreadyPending([], measured.key));
});

test("the alert names the tool, the size, and where the evidence is", () => {
  const measured = measureMcpResponse(gatewayCall(13_480_985));
  const limit = 1024 * 1024;
  assert.equal(alertTitle(measured, limit), "MCP response over 1.0 MiB: math/review_queue returned 12.9 MiB");
  const body = alertBody(measured, { input: { limit: 1 }, cwd: "/home/kenan", limit });
  assert.match(body, /\/tmp\/x\/output\.txt/);
  assert.match(body, /"limit":1/);
  assert.match(body, /PI_MCP_SIZE_ALERT_KB/);
});

test("a session fires one alert per tool and keeps serving tool results", async () => {
  const handlers = [];
  const pi = { on: (event, handler) => handlers.push([event, handler]) };
  const inbox = [];
  const filed = [];
  registerGuard(pi, { PI_MCP_SIZE_ALERT_KB: "1" }, {
    readInbox: () => inbox,
    fileAlert: (title, body) => {
      filed.push(title);
      inbox.push(`# ${title}\n\n${body}`);
      return Promise.resolve(true);
    },
  });
  assert.deepEqual(handlers.map(([event]) => event), ["tool_result"]);
  const [, onResult] = handlers[0];

  assert.equal(await onResult({ toolName: "mcp", input: {}, details: gatewayCall(2_000_000) }, { cwd: "/tmp" }), undefined);
  assert.equal(await onResult({ toolName: "mcp", input: {}, details: gatewayCall(3_000_000) }, { cwd: "/tmp" }), undefined);
  assert.equal(filed.length, 1);

  await onResult({ toolName: "mcp", input: {}, details: { ...gatewayCall(2_000_000), tool: "search" } }, { cwd: "/tmp" });
  assert.equal(filed.length, 2, "a different tool is a different condition");

  await onResult({ toolName: "bash", input: {}, details: { exitCode: 0 } }, { cwd: "/tmp" });
  assert.equal(filed.length, 2);
});

test("the guard is never the reason a tool result fails to arrive", async () => {
  const handlers = [];
  const pi = { on: (event, handler) => handlers.push([event, handler]) };
  registerGuard(pi, { PI_MCP_SIZE_ALERT_KB: "1" }, {
    readInbox: () => {
      throw new Error("inbox is gone");
    },
  });
  assert.equal(await handlers[0][1]({ input: {}, details: gatewayCall(9_000_000) }, {}), undefined);
});

test("PI_MCP_SIZE_GUARD=off registers nothing", () => {
  const handlers = [];
  registerGuard({ on: (event) => handlers.push(event) }, { PI_MCP_SIZE_GUARD: "off" });
  assert.deepEqual(handlers, []);
});

test("the alert CLI files it where the inbox consumer reads", async (t) => {
  let alertPath;
  try {
    alertPath = execFileSync("sh", ["-c", "command -v alert"], { encoding: "utf8" }).trim();
  } catch {
    t.skip("the alert CLI is not on PATH");
    return;
  }
  const inbox = mkdtempSync(join(tmpdir(), "mcp-size-guard-inbox-"));
  try {
    const handlers = [];
    registerGuard({ on: (event, handler) => handlers.push(handler) }, {
      ...process.env,
      PI_MCP_SIZE_ALERT_KB: "1",
      MACHINE_ALERTS_INBOX: inbox,
      PATH: process.env.PATH,
    });
    await handlers[0]({ input: { limit: 1 }, details: gatewayCall(13_480_985) }, { cwd: "/home/kenan" });

    const files = readdirSync(inbox);
    assert.equal(files.length, 1, `expected one alert from ${alertPath}, got ${files.join(", ")}`);
    const text = readFileSync(join(inbox, files[0]), "utf8");
    assert.match(text, /source: mcp-size-guard/);
    assert.match(text, /mcp-oversize math\/review_queue/);

    // The second one is silent because the first is still sitting there unread.
    await handlers[0]({ input: {}, details: gatewayCall(13_480_985) }, { cwd: "/home/kenan" });
    assert.equal(readdirSync(inbox).length, 1);
  } finally {
    rmSync(inbox, { recursive: true, force: true });
  }
});
