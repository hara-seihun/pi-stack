import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Result, ThreadSettings, WorkOutcome } from "./contracts.js";
import type { ImportMessage, ImportThread, ThreadService } from "./service.js";
import { resolveThreadSettings } from "./settings.js";
import { catalogModel } from "../catalog.js";
import { adoptImportProvenance } from "./import-provenance.js";

type Row = Record<string, any>;
const sourceTables = ["sessions", "work_items", "subagents", "thread_delegations", "delegation_results", "session_cores", "core_agents", "core_dispatches", "core_switches"];
const time = (value: unknown) => typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Date.now();
const parse = (value: string | null | undefined, otherwise: any) => value ? JSON.parse(value) : otherwise;
const failure = (message: string): Result<never> => ({ ok: false, error: { code: "conflict", message } });

export function importRemoteThreads(service: ThreadService, db: DatabaseSync, options: {
  sessionsDir: string; resolveCwd?: (workspace: string) => string;
}): Result<{ threads: number; messages: number }> {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Row[]).map(row => row.name));
  if (!tables.has("sessions")) return finishImport(service, 0, 0);
  const all = (name: string): Row[] => tables.has(name) ? db.prepare(`SELECT * FROM "${name}"`).all() as Row[] : [];
  try {
    const sessions = all("sessions"), work = all("work_items"), coreRows = all("session_cores"), children = all("subagents");
    if (work.some(item => ["running", "dispatched"].includes(item.state))) return failure("Thread cutover requires active input to settle under its owning release");
    const threads = new Map<string, ImportThread>();
    const messages = new Map<string, ImportMessage>();
    const views: Row[] = [];
    const nativeTrees: { rootId: string; nodes: Row[] }[] = [];
    for (const row of sessions) {
      const custody = coreRows.find(core => core.session_id === row.id);
      const treePath = custody && join(custody.state_dir, "pi-tree.json");
      const tree = treePath && existsSync(treePath) ? JSON.parse(readFileSync(treePath, "utf8")) : undefined;
      if (tree && (!Array.isArray(tree.nodes) || tree.rootId !== row.id)) return failure(`Invalid recorded Pi thread tree for ${row.id}`);
      if (tree?.nodes.some((node: Row) => node.busy || node.work?.status === "running")) return failure(`Thread ${row.id} still has active native execution`);
      if (tree?.nodes.some((node: Row) => node.work && node.work.status !== "complete")) return failure(`Thread ${row.id} has an unknown native work state`);
      const native = tree?.nodes.find((node: Row) => node.id === row.id);
      const model = native?.model ?? row.initial_model ?? "astra";
      const provider = native?.provider ?? row.current_provider ?? row.initial_provider;
      const requested = model.includes("/") || !provider ? model : `${provider}/${model}`;
      const selected = resolveThreadSettings({ model: catalogModel(model)?.id ?? requested, thinkingLevel: native?.thinkingLevel ?? row.initial_thinking ?? undefined,
        speed: row.service_tier === "priority" ? "priority" : "standard" });
      if (!selected.ok) return selected;
      threads.set(row.id, { id: row.id, parentId: children.find(child => child.session_id === row.id)?.parent_session_id ?? null,
        title: row.name, cwd: native?.cwd ?? options.resolveCwd?.(row.workspace_id) ?? row.workspace_id,
        sessionFile: native?.sessionFile ?? row.session_path ?? join(options.sessionsDir, `${row.id}.jsonl`), settings: selected.value,
        stopped: !!row.archived_at || ["STOPPED", "FAILED"].includes(row.state), createdAt: time(row.created_at), updatedAt: time(row.updated_at),
        metadata: { profileId: row.profile_id, meetingId: row.meeting_id, bashTimeoutSeconds: row.bash_timeout_seconds,
          nativeHistoryRequired: Boolean(native?.sessionFile ?? row.session_path),
          archived: !!row.archived_at, archivedAt: row.archived_at, initialProvider: row.initial_provider,
          initialModel: row.initial_model, importedFrom: { source: "remote", id: row.id, nativeStateDirectory: custody?.state_dir } } });
      views.push(row);
      if (tree) nativeTrees.push({ rootId: row.id, nodes: tree.nodes });
    }
    for (const { rootId, nodes } of nativeTrees) for (const node of nodes) {
      if (node.id === rootId) continue;
      const root = threads.get(rootId)!;
      const selected = resolveThreadSettings({ model: catalogModel(node.model)?.id ?? (node.provider ? `${node.provider}/${node.model}` : node.model),
        thinkingLevel: node.thinkingLevel, speed: "standard" });
      if (!selected.ok) return selected;
      if (threads.has(node.id)) return failure(`Native child ${node.id} has a second thread identity`);
      threads.set(node.id, { id: node.id, parentId: node.parentId, title: node.name, cwd: node.cwd, sessionFile: node.sessionFile,
        settings: selected.value, stopped: root.stopped || node.state === "cancelled", createdAt: root.createdAt, updatedAt: root.updatedAt,
        metadata: { ...root.metadata, nativeHistoryRequired: true, importedFrom: { source: "pi-child", rootId, id: node.id } } });
      views.push({ id: node.id, display_order: 0, idle_unread: 0, named_at_message_count: 0 });
      if (node.work) {
        const outcome: WorkOutcome = node.state === "failed" ? "failed" : node.state === "cancelled" ? "cancelled" : "complete";
        messages.set(node.work.id, { id: node.work.id, threadId: node.id, senderId: node.parentId, text: node.work.task,
          state: outcome === "cancelled" ? "cancelled" : "complete", outcome, createdAt: root.updatedAt,
          finalMessage: { role: "assistant", content: [{ type: "text", text: node.work.result ?? "" }] } });
        if (!node.work.delivered && node.parentId) {
          const receipt = `import-result:${node.id}:${node.work.id}`;
          messages.set(receipt, { id: receipt, threadId: node.parentId, senderId: node.id, source: "notification", delivery: "steer", replyTo: node.work.id,
            text: JSON.stringify({ type: "thread_idle", threadId: node.id, workId: node.work.id, outcome, finalMessage: node.work.result ?? null }) });
        }
      }
    }
    const delegations = all("thread_delegations");
    for (const item of work) {
      const relation = delegations.find(delegation => delegation.work_id === item.id);
      messages.set(item.id, { id: item.id, requestId: item.request_id, threadId: item.session_id, senderId: relation?.parent_session_id,
        text: item.text, images: parse(item.images, []), delivery: item.delivery === "hardSteer" ? "hardSteer" : item.delivery === "steer" ? "steer" : "queue",
        source: delegations.some(delegation => delegation.reply_work_id === item.id) ? "notification" : "explicit",
        state: item.state === "complete" ? "complete" : item.state === "cancelled" ? "cancelled" : "queued",
        outcome: item.state === "cancelled" ? "cancelled" : item.last_error && item.state === "complete" ? "failed" : item.state === "complete" ? "complete" : undefined,
        insertedAt: item.inserted_at ? time(item.inserted_at) : undefined, createdAt: time(item.created_at) });
    }
    for (const result of all("delegation_results")) {
      const relation = delegations.find(delegation => delegation.work_id === result.work_id);
      if (!relation || relation.reply_work_id) continue;
      const child = work.find(item => item.id === result.work_id);
      if (!child) return failure(`Delegation ${result.work_id} has no retained assignment`);
      const receipt = `import-result:${child.session_id}:${result.work_id}`;
      messages.set(receipt, { id: receipt, threadId: relation.parent_session_id, senderId: child.session_id,
        source: "notification", delivery: "steer", replyTo: result.work_id,
        text: JSON.stringify({ type: "thread_idle", threadId: child.session_id, workId: result.work_id, outcome: result.status, finalMessage: result.result, error: result.error }) });
    }
    const imported = service.importState([...threads.values()], [...messages.values()]);
    if (!imported.ok) return imported;
    replacePresentationParents(db, views);
    return finishImport(service, threads.size, messages.size);
  } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
}

function finishImport(service: ThreadService, threads: number, messages: number): Result<{ threads: number; messages: number }> {
  const adopted = adoptImportProvenance({ threads: service.snapshot() });
  if (!adopted.ok) return adopted;
  for (const [id, metadata] of Object.entries(adopted.value.metadata)) {
    const current = service.get(id);
    if (!current) return failure(`Imported provenance lost thread ${id}`);
    const updated = service.update(id, { metadata: { ...current.metadata, ...metadata } });
    if (!updated.ok) return updated;
  }
  return { ok: true, value: { threads, messages } };
}

function replacePresentationParents(db: DatabaseSync, views: Row[]): void {
  const schemas = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL").all() as Row[];
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS thread_views (id TEXT PRIMARY KEY, display_order INTEGER NOT NULL DEFAULT 0, idle_unread INTEGER NOT NULL DEFAULT 0, named_at_message_count INTEGER NOT NULL DEFAULT 0)");
    db.exec("CREATE TABLE IF NOT EXISTS message_annotations (work_id TEXT PRIMARY KEY, meeting_transcript TEXT NOT NULL DEFAULT '[]')");
    if (schemas.some(schema => schema.name === "work_items")) db.exec("INSERT OR IGNORE INTO message_annotations SELECT id,meeting_transcript FROM work_items");
    const insert = db.prepare("INSERT OR IGNORE INTO thread_views VALUES(?,?,?,?)");
    for (const view of views) insert.run(view.id, view.display_order ?? 0, view.idle_unread ?? 0, view.named_at_message_count ?? 0);
    for (const { name, sql } of schemas) {
      if (sourceTables.includes(name) || !/REFERENCES\s+sessions\b/i.test(sql)) continue;
      const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").all(name) as { sql: string }[];
      const temporary = `thread_cutover_${name}`;
      const definition = String(sql).replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|\w+)/i, `CREATE TABLE "${temporary}"`)
        .replace(/REFERENCES\s+sessions\b/gi, "REFERENCES thread_views");
      db.exec(definition);
      db.exec(`INSERT INTO "${temporary}" SELECT * FROM "${name}"; DROP TABLE "${name}"; ALTER TABLE "${temporary}" RENAME TO "${name}";`);
      for (const object of objects) db.exec(object.sql);
    }
    for (const name of sourceTables) db.exec(`DROP TABLE IF EXISTS "${name}"`);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length) throw new Error("Thread cutover would break presentation references");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  finally { db.exec("PRAGMA foreign_keys=ON"); }
}
