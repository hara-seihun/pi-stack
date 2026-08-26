import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureSupervisorSchema } from "./database";
import { exportSessions, importSessions, removeExportedSessions } from "./session-migration";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("session migration", () => {
  test("moves a settled remote thread into an empty local supervisor", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-remote-migration-"));
    roots.push(root);
    const sourceData = join(root, "source");
    const destinationData = join(root, "destination");
    const bundleRoot = join(root, "bundle");
    mkdirSync(join(sourceData, "sessions"), { recursive: true });
    mkdirSync(join(sourceData, "service-tiers"), { recursive: true });
    const sessionFile = join(sourceData, "sessions", "thread.jsonl");
    writeFileSync(sessionFile, '{"type":"session","id":"pi-session"}\n', { mode: 0o600 });
    writeFileSync(join(sourceData, "service-tiers", "thread"), "priority\n", { mode: 0o600 });

    const sourceDbPath = join(sourceData, "supervisor.sqlite3");
    const source = new Database(sourceDbPath, { create: true, strict: true });
    ensureSupervisorSchema(source);
    source.query(`INSERT INTO sessions(
      id,name,workspace_id,session_path,state,created_at,updated_at,execution_target,remote_cwd,service_tier,archived_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      "thread", "812", "home", sessionFile, "STOPPED", "2026-08-25T00:00:00Z", "2026-08-25T01:00:00Z",
      "converge", "/home/kenan/converge", "priority", "2026-08-25T01:00:00Z",
    );
    source.query("INSERT INTO events(seq,session_id,time,type,payload) VALUES(?,?,?,?,?)")
      .run(91, "thread", "2026-08-25T00:00:00Z", "user", '{"text":"hello"}');
    source.query("INSERT INTO session_contexts(session_id,captured_at,context) VALUES(?,?,?)")
      .run("thread", 42, '[{"role":"user","content":"hello"}]');
    source.query("INSERT INTO requests(request_id,session_id,kind,status,response,created_at) VALUES(?,?,?,?,?,?)")
      .run("request", "thread", "message", 202, "{}", "2026-08-25T00:00:00Z");
    source.query(`INSERT INTO work_items(
      id,session_id,request_id,event_seq,text,state,available_at,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      "work", "thread", "request", 91, "hello", "complete", 0, "2026-08-25T00:00:00Z", "2026-08-25T00:01:00Z",
    );
    source.close();

    const bundle = exportSessions({ dbPath: sourceDbPath, dataRoot: sourceData, target: "converge", bundleRoot });
    expect(bundle.tables.sessions).toHaveLength(1);
    importSessions({
      dbPath: join(destinationData, "supervisor.sqlite3"),
      dataRoot: destinationData,
      bundleRoot,
      workspace: "work",
    });

    const destination = new Database(join(destinationData, "supervisor.sqlite3"), { readonly: true, strict: true });
    const session = destination.query("SELECT * FROM sessions WHERE id='thread'").get() as any;
    expect(session.workspace_id).toBe("work");
    expect(session.execution_target).toBe("local");
    expect(session.remote_cwd).toBeNull();
    expect(session.session_path).toBe(join(destinationData, "sessions", "thread.jsonl"));
    expect(readFileSync(session.session_path, "utf8")).toContain("pi-session");
    expect(readFileSync(join(destinationData, "service-tiers", "thread"), "utf8")).toBe("priority\n");
    expect((destination.query("SELECT COUNT(*) count FROM events").get() as any).count).toBe(1);
    expect((destination.query("SELECT value FROM metadata WHERE key='last_thread_number'").get() as any).value).toBe("812");
    destination.close();

    expect(removeExportedSessions({ dbPath: sourceDbPath, bundleRoot })).toBe(1);
    const cleaned = new Database(sourceDbPath, { readonly: true, strict: true });
    for (const table of ["sessions", "events", "session_contexts", "requests", "work_items"])
      expect((cleaned.query(`SELECT COUNT(*) count FROM ${table}`).get() as any).count).toBe(0);
    cleaned.close();
  });

  test("preserves an empty thread whose Pi process never created its session file", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-remote-migration-"));
    roots.push(root);
    const sourceData = join(root, "source");
    const destinationData = join(root, "destination");
    mkdirSync(sourceData, { recursive: true });
    const sourceDbPath = join(sourceData, "supervisor.sqlite3");
    const source = new Database(sourceDbPath, { create: true, strict: true });
    ensureSupervisorSchema(source);
    const missing = join(sourceData, "sessions", "never-created.jsonl");
    source.query(`INSERT INTO sessions(
      id,name,workspace_id,session_path,state,created_at,updated_at,execution_target,archived_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      "empty", "104", "home", missing, "STOPPED", "2026-08-16T00:00:00Z",
      "2026-08-16T00:01:00Z", "converge", "2026-08-16T00:01:00Z",
    );
    source.query("INSERT INTO requests(request_id,session_id,kind,status,response,created_at) VALUES(?,?,?,?,?,?)")
      .run("create", "empty", "create", 201, "{}", "2026-08-16T00:00:00Z");
    source.close();

    const bundleRoot = join(root, "bundle");
    const bundle = exportSessions({ dbPath: sourceDbPath, dataRoot: sourceData, target: "converge", bundleRoot });
    expect(bundle.sessionFiles).toHaveLength(0);
    importSessions({
      dbPath: join(destinationData, "supervisor.sqlite3"),
      dataRoot: destinationData,
      bundleRoot,
      workspace: "work",
    });

    const destination = new Database(join(destinationData, "supervisor.sqlite3"), { readonly: true, strict: true });
    expect((destination.query("SELECT session_path FROM sessions WHERE id='empty'").get() as any).session_path).toBeNull();
    expect((destination.query("SELECT COUNT(*) count FROM requests WHERE session_id='empty'").get() as any).count).toBe(1);
    destination.close();
  });

  test("refuses a missing session file when other thread content exists", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-remote-migration-"));
    roots.push(root);
    const dbPath = join(root, "supervisor.sqlite3");
    const db = new Database(dbPath, { create: true, strict: true });
    ensureSupervisorSchema(db);
    const missing = join(root, "sessions", "missing.jsonl");
    db.query(`INSERT INTO sessions(
      id,name,workspace_id,session_path,state,created_at,updated_at,execution_target,archived_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      "contentful", "Thread", "home", missing, "STOPPED", "now", "now", "converge", "now",
    );
    db.query("INSERT INTO events(seq,session_id,time,type,payload) VALUES(?,?,?,?,?)")
      .run(1, "contentful", "now", "user", '{"text":"must not be lost"}');
    db.close();

    expect(() => exportSessions({
      dbPath, dataRoot: root, target: "converge", bundleRoot: join(root, "bundle"),
    })).toThrow("is missing");
  });

  test("refuses to export unfinished work", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-remote-migration-"));
    roots.push(root);
    const dbPath = join(root, "supervisor.sqlite3");
    const db = new Database(dbPath, { create: true, strict: true });
    ensureSupervisorSchema(db);
    db.query("INSERT INTO sessions(id,name,workspace_id,state,created_at,updated_at,execution_target) VALUES(?,?,?,?,?,?,?)")
      .run("active", "Active", "home", "RUNNING", "now", "now", "converge");
    db.close();
    expect(() => exportSessions({ dbPath, dataRoot: root, target: "converge", bundleRoot: join(root, "bundle") }))
      .toThrow("sessions are still active");
  });
});
