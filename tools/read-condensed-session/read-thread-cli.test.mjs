import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { READ_THREAD_CONTRACT, readerHelp } from "./contract.mjs";

test("help and context metadata expose the same reader contract without a session or database", () => {
  const env = { ...process.env, PI_REMOTE_DATA: "/missing/remote-data", PI_SESSION_FILE: "" };
  const run = (...args) => spawnSync(process.execPath, [new URL("read-thread", import.meta.url).pathname, ...args], { env, encoding: "utf8", timeout: 2000 });
  const contract = run("--contract");
  assert.equal(contract.status, 0, contract.stderr);
  assert.deepEqual(JSON.parse(contract.stdout), READ_THREAD_CONTRACT);
  assert.equal(run("--help").stdout, `${readerHelp()}\n`);
  assert.equal(run("--contract", "self").status, 1);
});

test("self and explicit JSONL paths share complete history and bounded search without a database", () => {
  const root = mkdtempSync(join(tmpdir(), "read-thread-history-"));
  try {
    const session = join(root, "session with spaces.jsonl");
    const entry = (id, parentId, role, text) => ({ type: "message", id, parentId, timestamp: "2026-09-01T00:00:00Z", message: { role, content: [{ type: "text", text }] } });
    const entries = [
      { type: "session", id: "pi-session", version: 3 },
      entry("u", null, "user", "original request needle"),
      entry("result", "u", "toolResult", "x".repeat(12_000) + " distant needle"),
      entry("other", "u", "assistant", "abandoned branch needle"),
      { type: "compaction", id: "compact", parentId: "result", summary: "summary", retainedTail: [] },
      entry("final", "compact", "assistant", "finished"),
    ];
    const source = entries.map(JSON.stringify).join("\n") + "\n";
    writeFileSync(session, source);
    const env = { ...process.env, PI_SESSION_FILE: session, PI_SESSION_ID: "pi-session", PI_REMOTE_DATA: join(root, "no-database") };
    const run = (...args) => spawnSync(process.execPath, [new URL("read-thread", import.meta.url).pathname, ...args], { env, encoding: "utf8", timeout: 2000 });
    assert.equal(run("--path", "self").stdout.trim(), session);
    assert.equal(run("--path", session).stdout.trim(), session);
    const ordinary = run("self");
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.match(ordinary.stdout, /original request/);
    assert.doesNotMatch(ordinary.stdout, /abandoned branch|distant needle/);
    assert.match(run("--full", "self").stdout, /distant needle/);
    const raw = run("--all", "--raw", session);
    assert.equal(raw.status, 0, raw.stderr);
    assert.equal(raw.stdout, source);
    assert.match(run("--leaf", "other", "self").stdout, /abandoned branch/);
    assert.doesNotMatch(run("--leaf", "other", "self").stdout, /finished/);
    const search = run("--search", "NEEDLE", "--limit", "1", "self");
    assert.match(search.stdout, /:2 \[entry u\]/);
    assert.match(search.stdout, /next --offset 1/);
    const next = run("--search", "needle", "--limit", "1", "--offset", "1", "self");
    assert.match(next.stdout, /:3 \[entry result\]/);
    assert.match(next.stdout, /distant needle/);
    assert.ok(next.stdout.length < 2500);
    assert.match(run("--all", "--search", "abandoned", session).stdout, /:4 \[entry other\]/);
    assert.match(run("--regex", "--search", "distant.*needle", "self").stdout, /distant needle/);
    assert.equal(run("--regex", "--search", "[", "self").status, 1);
    assert.equal(run("--all", "--leaf", "other", "self").status, 1);
    assert.equal(run("--output", session, "self").status, 1);
    assert.equal(readFileSync(session, "utf8"), source);
    delete env.PI_SESSION_FILE;
    assert.match(run("--path", "self").stderr, /self requires PI_SESSION_FILE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SSH discovery reads the person's registry and reports requests that never reached Pi", () => {
  const root = mkdtempSync(join(tmpdir(), "read-thread-cli-"));
  try {
    const persons = join(root, "persons");
    mkdirSync(persons);
    writeFileSync(join(persons, `${userInfo().username}.json`), JSON.stringify({ environment: { PI_REMOTE_DATA: root } }));
    const db = new DatabaseSync(join(root, "supervisor.sqlite3"));
    db.exec(`
      CREATE TABLE sessions(id,name,session_path,state,updated_at,archived_at);
      CREATE TABLE work_items(session_id,text,state,attempts,last_error,created_at);
      CREATE TABLE events(seq,session_id,time,type,payload);
      INSERT INTO sessions VALUES('thread','818',NULL,'IDLE','2026-09-08T19:07:00Z',NULL);
      INSERT INTO work_items VALUES('thread','Check the jobs','cancelled',2,'Cancelled by user','2026-09-08T19:06:00Z');
      INSERT INTO events VALUES(1,'thread','2026-09-08T19:06:01Z','notice','Authentication unavailable');
    `);
    db.close();
    const env = { ...process.env, PI_REMOTE_PERSONS_DIR: persons };
    delete env.PI_REMOTE_DATA;
    const result = spawnSync(process.execPath, [new URL("read-thread", import.meta.url).pathname, "818"], { env, encoding: "utf8", timeout: 2000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /not a model transcript/);
    assert.match(result.stdout, /Check the jobs/);
    assert.match(result.stdout, /cancelled, 2 attempts/);
    assert.match(result.stdout, /Authentication unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
