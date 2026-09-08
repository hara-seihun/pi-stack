import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

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
