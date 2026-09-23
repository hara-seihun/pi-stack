import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { publicationConfig } from "./publication-fixture.mjs";

const configRoot = mkdtempSync(join(tmpdir(), "publication-config-"));
process.env.PI_STACK_PUBLICATION_CONFIG = publicationConfig(configRoot);
process.on("exit", () => rmSync(configRoot, { recursive: true, force: true }));
const command = fileURLToPath(new URL("../deploy/publication", import.meta.url));
const requestId = "PUB-0123456789abcdef01234567";
const sessionId = "01234567-0123-4123-a123-0123456789ab";

function issues(root, inbox) {
  const result = spawnSync(process.execPath, [command, "issues"], {
    encoding: "utf8",
    env: { ...process.env, PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_ALERT_INBOX: inbox },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function fixture(t, status = "failed") {
  const root = mkdtempSync(join(tmpdir(), "publication-report-"));
  mkdirSync(join(root, "requests"));
  const receipt = join(root, "requests", `${requestId}.json`);
  const inbox = join(root, "inbox");
  mkdirSync(inbox);
  const request = {
    requestId, sourceSha: "a".repeat(40), status, step: status === "failed" ? "checks" : "complete",
    failures: [], alert: { key: status === "failed" ? "failed:2026-09-13" : status, status: "queued" },
    ...(status === "failed" ? { failure: { at: "2026-09-13", message: "integration checks exited 1", log: "/fixture/checks.log" } } : {}),
  };
  writeFileSync(receipt, JSON.stringify(request));
  // The thread's queue is what confirms delivery: the report's work leaves it
  // once the agent has the message.
  const state = { requests: [], queued: [], unavailable: false, dispatch: false, accepted: new Map() };
  const server = createServer(async (req, res) => {
    if (state.unavailable) { res.writeHead(503); res.end("fixture unavailable"); return; }
    let body = "";
    for await (const part of req) body += part;
    const url = new URL(req.url, "http://fixture");
    if (req.method === "POST") {
      const data = JSON.parse(body);
      state.requests.push(data);
      if (!state.accepted.has(data.requestId)) state.accepted.set(data.requestId, `work-${state.accepted.size}`);
      const workId = state.accepted.get(data.requestId);
      if (state.dispatch) state.queued = state.queued.filter(id => id !== workId);
      else if (!state.queued.includes(workId)) state.queued.push(workId);
      res.end(JSON.stringify({ accepted: true, workId }));
    } else {
      res.end(JSON.stringify({ session: { id: sessionId, queuedMessages: state.queued.map(id => ({ id })) } }));
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
      env: { ...process.env, PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_ALERT_INBOX: inbox },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    const code = await new Promise(resolve => child.on("close", resolve));
    return { code, stdout, stderr, receipt: JSON.parse(readFileSync(receipt, "utf8")) };
  }
  return { run, url, state, receipt, root, inbox };
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
  state.queued.length = 0; // the agent received it
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

test("cancelled requests read as terminal failures without repair alerts", async t => {
  const { run, url, state, inbox } = await fixture(t, "cancelled");
  state.dispatch = true;
  const result = await run(url, sessionId);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.receipt.status, "failed");
  assert.equal(result.receipt.failure.reason, "cancelled");
  assert.match(state.requests[0].text, /Status: failed/);
  assert.match(state.requests[0].text, /Reason: cancelled/);
  assert.doesNotMatch(state.requests[0].text, /dedicated repair owner/);
  assert.equal(existsSync(join(inbox, "pi-stack-publication-issues.md")), false);
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


test("repair transitions replace one bounded alert derived from request receipts", async t => {
  const { run, url, state, receipt, root, inbox } = await fixture(t);
  const directory = join(root, "repairs", requestId);
  mkdirSync(directory, { recursive: true });
  const repairPath = join(directory, "receipt.json");
  const repair = { status: "running", path: repairPath, failure: { excerpt: "nested log".repeat(100_000) } };
  writeFileSync(repairPath, JSON.stringify(repair));
  const request = JSON.parse(readFileSync(receipt, "utf8"));
  request.failure.excerpt = "log output".repeat(100_000);
  writeFileSync(receipt, JSON.stringify(request));
  let result = await run(url, sessionId);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(state.requests[0].text.length < 2000);
  assert.doesNotMatch(state.requests[0].text, /nested log|log output/);
  const successorId = "PUB-1123456789abcdef01234567";
  writeFileSync(join(root, "requests", `${successorId}.json`), JSON.stringify({
    ...request, requestId: successorId, sourceSha: "b".repeat(40), status: "failed",
  }));
  repair.status = "submitted";
  repair.successor = { requestId: successorId };
  writeFileSync(repairPath, JSON.stringify(repair));
  result = await run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readdirSync(inbox), ["pi-stack-publication-issues.md"]);
  const index = issues(root, inbox);
  assert.deepEqual(index.issues.map(issue => issue.requestId), [successorId]);
  assert.equal(existsSync(join(root, "issues.json")), false);
  writeFileSync(join(root, "requests", `${successorId}.json`), JSON.stringify({
    requestId: successorId, sourceSha: "b".repeat(40), status: "published", step: "complete",
  }));
  result = await run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(join(inbox, "pi-stack-publication-issues.md")), false);
  assert.equal(JSON.parse(readFileSync(receipt, "utf8")).status, "failed");
});

test("acknowledgement survives reconciliation and a changed failure returns to the inbox", async t => {
  const { run, root, receipt, inbox } = await fixture(t);
  let result = await run();
  assert.equal(result.code, 0, result.stderr);
  const ack = spawnSync(process.execPath, [command, "acknowledge-issues"], {
    encoding: "utf8", env: { ...process.env, PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_ALERT_INBOX: inbox },
  });
  assert.equal(ack.status, 0, ack.stderr);
  assert.equal(existsSync(join(inbox, "pi-stack-publication-issues.md")), false);
  result = await run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(join(inbox, "pi-stack-publication-issues.md")), false);
  assert.equal(result.receipt.status, "failed");
  result.receipt.failure.at = "2026-09-16";
  writeFileSync(receipt, JSON.stringify(result.receipt));
  result = await run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(join(inbox, "pi-stack-publication-issues.md")), true);
  assert.ok(JSON.parse(readFileSync(join(root, "issue-acknowledgements.json"), "utf8"))[requestId]);
});

test("proved source ancestry clears failures but never hides host restoration custody", async t => {
  const { run, root, receipt, inbox } = await fixture(t);
  const repository = join(root, "repository");
  mkdirSync(repository);
  for (const args of [["init", "--quiet"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "--allow-empty", "-m", "proved source"]]) {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).stdout.trim();
  const request = JSON.parse(readFileSync(receipt, "utf8"));
  request.sourceSha = sha;
  writeFileSync(receipt, JSON.stringify(request));
  const publishedId = "PUB-1123456789abcdef01234567";
  const published = { requestId: publishedId, sourceSha: sha, integrationSha: sha, status: "published", publishedAt: "2026-09-15", step: "complete", finalProof: { path: "/fixture/both-host-proof.json" } };
  const publishedPath = join(root, "requests", `${publishedId}.json`);
  writeFileSync(publishedPath, JSON.stringify(published));
  let result = await run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(join(inbox, "pi-stack-publication-issues.md")), false);
  assert.equal(issues(root, inbox).resolved[0].resolution.proof, published.finalProof.path);
  published.maintenance = { hosts: { gmktec: { state: "paused" } } };
  writeFileSync(publishedPath, JSON.stringify(published));
  result = await run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(issues(root, inbox).issues.map(issue => issue.requestId), [publishedId]);
});

test("publication history retains delivery proof across unrelated source roots", async t => {
  const { root, receipt, inbox } = await fixture(t);
  const repository = join(root, "repository");
  mkdirSync(repository);
  function git(...args) {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git("init", "--quiet");
  const commit = message => {
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const source = commit("requested source");
  const delivered = commit("successful integration");
  git("checkout", "--quiet", "--orphan", "public");
  const publicRoot = commit("public source root");
  git("checkout", "--quiet", "--orphan", "undelivered");
  const missing = commit("unfinished work");
  const request = JSON.parse(readFileSync(receipt, "utf8"));
  writeFileSync(receipt, JSON.stringify({ ...request, sourceSha: source }));
  const deliveredId = "PUB-1123456789abcdef01234567";
  const publicId = "PUB-2123456789abcdef01234567";
  const missingId = "PUB-3123456789abcdef01234567";
  for (const [id, sha, publishedAt] of [[deliveredId, delivered, "2026-09-15"], [publicId, publicRoot, "2026-09-16"]]) {
    writeFileSync(join(root, "requests", `${id}.json`), JSON.stringify({
      requestId: id, sourceSha: sha, integrationSha: sha, status: "published", publishedAt,
      finalProof: { path: `/fixture/${id}.json` },
    }));
  }
  writeFileSync(join(root, "requests", `${missingId}.json`), JSON.stringify({ ...request, requestId: missingId, sourceSha: missing }));
  const index = issues(root, inbox);
  assert.deepEqual(index.issues.map(issue => issue.requestId), [missingId]);
  assert.deepEqual(index.resolved.find(item => item.requestId === requestId).resolution, {
    requestId: deliveredId, integrationSha: delivered, proof: `/fixture/${deliveredId}.json`,
  });
});

test("issue inspection remains read-only while the publication worker holds its lock", async t => {
  const { root, inbox } = await fixture(t);
  const holder = spawn("flock", [join(root, "worker.lock"), process.execPath, "-e",
    "process.stdout.write('locked'); process.stdin.resume()"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => holder.stdin.end());
  await new Promise((resolve, reject) => {
    holder.stdout.once("data", resolve);
    holder.once("error", reject);
  });
  assert.equal(issues(root, inbox).issues[0].requestId, requestId);
  assert.deepEqual(readdirSync(inbox), []);
});

test("an unattended failure backlog stays bounded and preserves every issue in its owner", async t => {
  const { run, root, inbox, receipt } = await fixture(t);
  const request = JSON.parse(readFileSync(receipt, "utf8"));
  for (let n = 1; n <= 90; n++) {
    const id = `PUB-${n.toString(16).padStart(24, "0")}`;
    writeFileSync(join(root, "requests", `${id}.json`), JSON.stringify({ ...request, requestId: id }));
  }
  const result = await run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readdirSync(inbox), ["pi-stack-publication-issues.md"]);
  assert.ok(readFileSync(join(inbox, "pi-stack-publication-issues.md")).length < 6000);
  assert.equal(issues(root, inbox).issues.length, 91);
  assert.equal(existsSync(join(root, "issues.json")), false);
});

test("a queued gate wait becomes a failed request with its dependency reason at the unchanged budget", t => {
  const root = mkdtempSync(join(tmpdir(), "publication-gate-budget-"));
  const requests = join(root, "requests");
  const inbox = join(root, "inbox");
  mkdirSync(requests, { recursive: true });
  mkdirSync(inbox);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reason = "active fleet work is still draining";
  const receipt = join(requests, `${requestId}.json`);
  writeFileSync(receipt, JSON.stringify({
    version: 3,
    requestId,
    sourceSha: "a".repeat(40),
    status: "queued",
    step: "waiting-for-pre-contract-runtime-gate",
    attempt: 3,
    blockedSince: "2026-09-15T10:00:00.000Z",
    nextAttemptAt: "2026-09-15T10:00:30.000Z",
    waiting: { reason, log: join(root, "gate.log") },
    failures: [],
  }));
  const result = spawnSync(process.execPath, [command, "drain"], {
    encoding: "utf8",
    env: { ...process.env, PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_ALERT_INBOX: inbox },
  });
  assert.equal(result.status, 0, result.stderr);
  const failed = JSON.parse(readFileSync(receipt, "utf8"));
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure.message, "Publication progress budget exhausted");
  assert.equal(failed.failure.reason, reason);
  assert.equal(failed.nextAttemptAt, undefined);
  assert.equal(JSON.parse(readFileSync(join(root, "repairs", requestId, "receipt.json"), "utf8")).failure.reason, reason);
});

test("pre-migration request files convert on read without losing history", t => {
  const root = mkdtempSync(join(tmpdir(), "publication-migration-"));
  const requests = join(root, "requests");
  const inbox = join(root, "inbox");
  mkdirSync(requests, { recursive: true });
  mkdirSync(inbox);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const blocked = {
    version: 2,
    requestId,
    sourceSha: "a".repeat(40),
    status: "blocked",
    step: "pre-contract-runtime-gate",
    blockedSince: "2026-09-15T10:00:00.000Z",
    nextAttemptAt: "2026-09-15T10:00:30.000Z",
    blocker: { reason: "active fleet work is still draining", log: "/fixture/gate.log" },
    failures: [{ at: "2026-09-15T09:59:00.000Z", message: "earlier attempt retained" }],
  };
  const receipt = join(requests, `${requestId}.json`);
  writeFileSync(receipt, JSON.stringify(blocked));
  let result = spawnSync(process.execPath, [command, "inspect", requestId], {
    encoding: "utf8",
    env: { ...process.env, PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_ALERT_INBOX: inbox },
  });
  assert.equal(result.status, 0, result.stderr);
  const queued = JSON.parse(result.stdout);
  assert.equal(queued.version, 3);
  assert.equal(queued.status, "queued");
  assert.equal(queued.waiting.reason, blocked.blocker.reason);
  assert.equal(queued.nextAttemptAt, blocked.nextAttemptAt);
  assert.deepEqual(queued.failures, blocked.failures);
  assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")), blocked);

  const cancelled = {
    ...blocked,
    status: "cancelled",
    failure: { at: "2026-09-15T10:01:00.000Z", message: "Publication cancelled; completed host release remains selected" },
    failures: [...blocked.failures, { at: "2026-09-15T10:01:00.000Z", message: "Publication cancelled; completed host release remains selected" }],
  };
  writeFileSync(receipt, JSON.stringify(cancelled));
  result = spawnSync(process.execPath, [command, "inspect", requestId], {
    encoding: "utf8",
    env: { ...process.env, PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_ALERT_INBOX: inbox },
  });
  assert.equal(result.status, 0, result.stderr);
  const failed = JSON.parse(result.stdout);
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure.reason, "cancelled");
  assert.equal(failed.failures.length, cancelled.failures.length);
});
