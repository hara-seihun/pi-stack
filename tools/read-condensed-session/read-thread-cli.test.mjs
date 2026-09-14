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
    const page = JSON.parse(run("--json", "--work", "--limit", "2", "self").stdout);
    assert.deepEqual(page.entries.map(entry => entry.entryId), ["compact", "final"]);
    const previous = JSON.parse(run("--json", "--work", "--limit", "2", "--cursor", page.nextCursor, "self").stdout);
    assert.deepEqual(previous.entries.map(entry => entry.entryId), ["u", "result"]);
    assert.equal(previous.entries[1].truncated, true);
    const chunk = JSON.parse(run("--json", "--work", "--entry", "result", "--offset", "4000", "--max-chars", "100", session).stdout);
    assert.equal(chunk.text, "x".repeat(100));
    assert.equal(chunk.nextOffset, 4100);
    assert.deepEqual(JSON.parse(run("--json", session).stdout).entries.map(entry => entry.entryId), ["u", "compact", "final"]);
    for (const flags of [["--search", "needle"], ["--all"], ["--leaf", "u"], ["--raw"], ["--full"]]) {
      assert.equal(run("--json", ...flags, "self").status, 1);
    }
    assert.equal(run("--json", "--limit", "21", "self").status, 1);
    assert.equal(run("--search", "needle", "--limit", "51", "self").status, 1);
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

test("subagent CLI discovers the caller, pages direct children and retains its distinct limits", () => {
  const root = mkdtempSync(join(tmpdir(), "read-thread-subagents-"));
  try {
    const db = new DatabaseSync(join(root, "threads.sqlite3"));
    db.exec(`
      CREATE TABLE thread(id,title,session_file,state,updated_at,created_at,parent_id,settings,metadata);
      CREATE TABLE thread_work(ordinal INTEGER PRIMARY KEY,id,thread_id,status,created_at,text);
      INSERT INTO thread VALUES('root','Coordinator',NULL,'running',1735689600000,1735689600000,NULL,'{}','{}');
      INSERT INTO thread VALUES('child','Child',NULL,'running',1735689600000,1735689600000,'root','{"model":"luna"}','{}');
      INSERT INTO thread VALUES('settled','Settled',NULL,'idle',1735689600000,1735689600000,'root','{"model":"astra"}','{}');
      INSERT INTO thread_work VALUES(1,'work1','child','done',1735776000000,'answer'),(2,'work2','settled','done',1735862400000,'done');
    `);
    db.close();
    const env = { ...process.env, PI_REMOTE_DATA: root, PI_THREAD_DATABASE: join(root, 'threads.sqlite3'), PI_THREAD_ID: "root", PI_REMOTE_SESSION_ID: "root" };
    const run = (...args) => spawnSync(process.execPath, [new URL("read-thread", import.meta.url).pathname, ...args], { env, encoding: "utf8", timeout: 2000 });
    const active = JSON.parse(run("--subagents").stdout);
    assert.deepEqual(active.subagents.map(child => child.threadId), ["child"]);
    assert.deepEqual(JSON.parse(run("--subagents", "self").stdout).subagents, active.subagents);
    const first = JSON.parse(run("--subagents", "--include-idle", "--limit", "1", "Coordinator").stdout);
    assert.equal(first.subagents[0].threadId, "settled");
    const second = JSON.parse(run("--subagents", "--include-idle", "--limit", "100", "--cursor", first.nextCursor, "root").stdout);
    assert.equal(second.subagents[0].threadId, "child");
    assert.equal(second.nextCursor, null);
    assert.equal(run("--subagents", "--limit", "101").status, 1);
    assert.equal(run("--subagents", "--search", "needle").status, 1);
    const transcript = JSON.parse(run("--json", "Child").stdout);
    assert.equal(transcript.source, "thread-inputs");
    assert.match(transcript.entries[0].text, /answer/);
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
    const db = new DatabaseSync(join(root, "threads.sqlite3"));
    db.exec(`
      CREATE TABLE thread(id,title,session_file,state,updated_at,metadata);
      CREATE TABLE thread_work(ordinal,thread_id,text,status,error,created_at);
      INSERT INTO thread VALUES('thread','818',NULL,'idle',1788894420000,'{}');
      INSERT INTO thread_work VALUES(1,'thread','Check the jobs','done','Cancelled by user',1788894360000);
    `);
    db.close();
    const env = { ...process.env, PI_REMOTE_PERSONS_DIR: persons };
    delete env.PI_REMOTE_DATA;
    delete env.PI_THREAD_DATABASE;
    const result = spawnSync(process.execPath, [new URL("read-thread", import.meta.url).pathname, "818"], { env, encoding: "utf8", timeout: 2000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /not a model transcript/);
    assert.match(result.stdout, /Check the jobs/);
    assert.match(result.stdout, /Cancelled by user/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
