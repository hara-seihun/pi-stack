import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSupervisorSchema } from "./database";

test("the supervisor adopts endpoint-local profiles and drops remote execution columns", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-remote-schema-"));
  try {
    const db = new Database(join(root, "supervisor.sqlite3"), { create: true, strict: true });
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_id TEXT NOT NULL,
        session_path TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, last_error TEXT, initial_provider TEXT,
        current_provider TEXT, initial_model TEXT, initial_thinking TEXT,
        execution_target TEXT NOT NULL DEFAULT 'local', remote_cwd TEXT,
        revision INTEGER NOT NULL DEFAULT 0, service_tier TEXT NOT NULL DEFAULT 'default',
        archived_at TEXT
      );
      CREATE TABLE uploads (
        path TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        environment TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO sessions(id,name,workspace_id,state,created_at,updated_at,execution_target)
        VALUES ('personal','1','hara','STOPPED','t','t','local'),
               ('remote','2','home','STOPPED','t','t','converge');
      INSERT INTO uploads(path,session_id,environment,created_at)
        VALUES ('/tmp/file','personal','local','t');
    `);

    ensureSupervisorSchema(db);

    expect(db.query("SELECT id,profile_id FROM sessions ORDER BY id").all()).toEqual([
      { id: "personal", profile_id: "personal" },
      { id: "remote", profile_id: "converge" },
    ]);
    const sessionColumns = (db.query("PRAGMA table_info(sessions)").all() as any[]).map((column) => column.name);
    expect(sessionColumns).toContain("profile_id");
    expect(sessionColumns).not.toContain("execution_target");
    expect(sessionColumns).not.toContain("remote_cwd");
    expect((db.query("PRAGMA table_info(uploads)").all() as any[]).map((column) => column.name))
      .not.toContain("environment");
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
