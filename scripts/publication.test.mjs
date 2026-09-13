import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const command = fileURLToPath(new URL("../deploy/publication", import.meta.url));
const requestId = "PUB-0123456789abcdef01234567";
const sessionId = "01234567-0123-4123-a123-0123456789ab";

async function fixture(t, status = "failed") {
  const root = mkdtempSync(join(tmpdir(), "publication-report-"));
  mkdirSync(join(root, "requests"));
  const receipt = join(root, "requests", `${requestId}.json`);
  const alert = join(root, "alert");
  writeFileSync(alert, '#!/bin/sh\nprintf "%s\\n" /fixture/alert.md\n', { mode: 0o700 });
  const request = {
    requestId, sourceSha: "a".repeat(40), status, step: status === "failed" ? "checks" : "complete",
    failures: [], alert: { key: status === "failed" ? "failed:2026-09-13" : status, status: "queued" },
    ...(status === "failed" ? { failure: { at: "2026-09-13", message: "integration checks exited 1", log: "/fixture/checks.log" } } : {}),
  };
  writeFileSync(receipt, JSON.stringify(request));
  const state = { requests: [], events: [{ seq: 1, type: "user", requestId: "initial" }], unavailable: false, dispatch: false, accepted: new Map() };
  const server = createServer(async (req, res) => {
    if (state.unavailable) { res.writeHead(503); res.end("fixture unavailable"); return; }
    let body = "";
    for await (const part of req) body += part;
    const url = new URL(req.url, "http://fixture");
    if (req.method === "POST") {
      const data = JSON.parse(body);
      state.requests.push(data);
      if (!state.accepted.has(data.requestId)) state.accepted.set(data.requestId, `work-${state.accepted.size}`);
      if (state.dispatch && !state.events.some(event => event.requestId === data.requestId)) state.events.push({ seq: state.events.length + 1, type: "user", requestId: data.requestId });
      res.end(JSON.stringify({ accepted: true, workId: state.accepted.get(data.requestId) }));
    } else if (url.pathname.endsWith("/events")) {
      res.end(JSON.stringify({ events: state.events.filter(event => event.seq > Number(url.searchParams.get("after") ?? 0)), session: { queuedMessages: [] } }));
    } else {
      res.end(JSON.stringify({ session: { id: sessionId } }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  async function run(...args) {
    const child = spawn(process.execPath, [command, "report", requestId, ...args], {
      env: { ...process.env, PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_ALERT_COMMAND: alert },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    const code = await new Promise(resolve => child.on("close", resolve));
    return { code, stdout, stderr, receipt: JSON.parse(readFileSync(receipt, "utf8")) };
  }
  return { run, url, state, receipt };
}

test("a filed machine alert does not suppress requester delivery; acceptance is not delivery", async t => {
  const { run, url, state } = await fixture(t);
  let result = await run(url, sessionId);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.receipt.status, "failed");
  assert.equal(result.receipt.report.status, "accepted");
  assert.equal(state.requests.length, 1);
  assert.match(state.requests[0].text, /integration checks exited 1/);
  assert.match(state.requests[0].text, /new commit/);
  state.events.push({ seq: 2, type: "user", requestId: state.requests[0].requestId });
  result = await run();
  assert.equal(result.receipt.report.status, "delivered");
  await run();
  assert.equal(state.requests.length, 1);
});

test("report transport failure remains retryable without retrying publication", async t => {
  const { run, url, state } = await fixture(t);
  state.unavailable = true;
  let result = await run(url, sessionId);
  assert.equal(result.receipt.report.status, "failed");
  assert.match(result.receipt.report.error, /503/);
  assert.equal(result.receipt.status, "failed");
  state.unavailable = false;
  state.dispatch = true;
  result = await run();
  assert.equal(result.receipt.report.status, "delivered");
  assert.equal(result.receipt.status, "failed");
});

test("a worker death after Remote acceptance reuses the idempotency key", async t => {
  const { run, url, state, receipt } = await fixture(t);
  let result = await run(url, sessionId);
  delete result.receipt.report.workId;
  result.receipt.report.status = "pending";
  writeFileSync(receipt, JSON.stringify(result.receipt));
  state.dispatch = true;
  result = await run();
  assert.equal(state.requests.length, 2);
  assert.equal(state.requests[0].requestId, state.requests[1].requestId);
  assert.equal(state.accepted.size, 1);
  assert.equal(result.receipt.report.status, "delivered");
});

test("published requests deliver completion and reject changing the requester", async t => {
  const { run, url, state } = await fixture(t, "published");
  state.dispatch = true;
  const result = await run(url, sessionId);
  assert.equal(result.receipt.report.status, "delivered");
  assert.match(state.requests[0].text, /Status: published/);
  assert.doesNotMatch(state.requests[0].text, /Repair source defects/);
  const changed = await run(url, "11234567-0123-4123-a123-0123456789ab");
  assert.equal(changed.code, 1);
  assert.match(changed.stderr, /another requester/);
});
