import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Result, ThreadSettings, WorkOutcome } from "./contracts.js";
import type { ImportMessage, ImportThread, ThreadService } from "./service.js";
import { resolveThreadSettings } from "./settings.js";
import { catalogModel } from "../catalog.js";
import { adoptImportProvenance } from "./import-provenance.js";
import { serializeThreadNotification } from "./message-format.js";

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
      if (tree?.dispatches?.some(([, dispatch]: [string, Row]) => dispatch.state === "pending")) return failure(`Thread ${row.id} has unconfirmed native dispatch admission`);
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
        held: !!row.archived_at || ["STOPPED", "FAILED"].includes(row.state), createdAt: time(row.created_at), updatedAt: time(row.updated_at),
        metadata: { profileId: row.profile_id, meetingId: row.meeting_id, bashTimeoutSeconds: row.bash_timeout_seconds,
          nativeHistoryRequired: Boolean(native?.sessionFile ?? row.session_path),
          archived: !!row.archived_at, archivedAt: row.archived_at, initialProvider: row.initial_provider,
          initialModel: row.initial_model, importedFrom: { source: "remote", id: row.id, nativeStateDirectory: custody?.state_dir } } });
      views.push(row);
      if (tree) nativeTrees.push({ rootId: row.id, nodes: tree.nodes });
    }
    for (const { rootId, nodes } of nativeTrees) importNativeChildren(rootId, nodes, threads, messages);
    for (const thread of threads.values()) if (!views.some(view => view.id === thread.id)) views.push({ id: thread.id });
    const delegations = all("thread_delegations");
    for (const item of work) {
      const relation = delegations.find(delegation => delegation.work_id === item.id);
      messages.set(item.id, { id: item.id, requestId: item.request_id, threadId: item.session_id, senderId: relation?.parent_session_id,
        text: item.text, images: parse(item.images, []), delivery: item.delivery === "hardSteer" ? "hardSteer" : item.delivery === "steer" ? "steer" : "queue",
        source: delegations.some(delegation => delegation.reply_work_id === item.id) ? "notification" : "explicit",
        state: ["complete", "cancelled"].includes(item.state) ? "done" : "queued",
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
        text: serializeThreadNotification({ type: "thread_idle", threadId: child.session_id, workId: result.work_id, outcome: result.status, finalMessage: result.result, error: result.error }) });
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
    const updated = service.update(id, { metadata: { ...metadata } });
    if (!updated.ok) return updated;
  }
  return { ok: true, value: { threads, messages } };
}

function replacePresentationParents(db: DatabaseSync, views: Row[]): void {
  const schemas = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL").all() as Row[];
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    const triggers = db.prepare("SELECT name,tbl_name FROM sqlite_master WHERE type='trigger'").all() as Row[];
    for (const trigger of triggers) if (sourceTables.includes(trigger.tbl_name)) db.exec(`DROP TRIGGER "${String(trigger.name).replaceAll('"', '""')}"`);
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

function importNativeChildren(rootId: string, nodes: Row[], threads: Map<string, ImportThread>, messages: Map<string, ImportMessage>): void {
  for (const node of nodes) {
      if (node.id === rootId) continue;
      const root = threads.get(rootId)!;
      const selected = resolveThreadSettings({ model: catalogModel(node.model)?.id ?? (node.provider ? `${node.provider}/${node.model}` : node.model),
        thinkingLevel: node.thinkingLevel, speed: "standard" });
      if (!selected.ok) throw new Error(selected.error.message);
      if (threads.has(node.id)) throw new Error(`Native child ${node.id} has a second thread identity`);
      threads.set(node.id, { id: node.id, parentId: node.parentId, title: node.name, cwd: node.cwd, sessionFile: node.sessionFile,
        settings: selected.value, held: root.held || node.state === "cancelled", createdAt: root.createdAt, updatedAt: root.updatedAt,
        metadata: { ...root.metadata, nativeHistoryRequired: true, importedFrom: { source: "pi-child", rootId, id: node.id } } });
      if (node.work) {
        const outcome: WorkOutcome = node.state === "failed" ? "failed" : node.state === "cancelled" ? "cancelled" : "complete";
        messages.set(node.work.id, { id: node.work.id, threadId: node.id, senderId: node.parentId, text: node.work.task,
          state: "done", outcome, createdAt: root.updatedAt,
          finalMessage: { role: "assistant", content: [{ type: "text", text: node.work.result ?? "" }] } });
        if (!node.work.delivered && node.parentId) {
          const receipt = `import-result:${node.id}:${node.work.id}`;
          messages.set(receipt, { id: receipt, threadId: node.parentId, senderId: node.id, source: "notification", delivery: "steer", replyTo: node.work.id,
            text: serializeThreadNotification({ type: "thread_idle", threadId: node.id, workId: node.work.id, outcome, finalMessage: node.work.result ?? null }) });
        }
      }
  }
}

export function importFleetThreads(service: ThreadService, db: DatabaseSync, options: {
  sessionsDir: string;
  settingsForProfile?: (profile: string) => ThreadSettings;
  selectService?: (thread: ImportThread) => ThreadService;
  services?: () => ThreadService[];
}): Result<{ threads: number; messages: number }> {
  try {
    const controls = new Map((db.prepare("SELECT key,value FROM control").all() as {key:string;value:string}[]).map(row => [row.key,row.value]));
    const runs = (db.prepare("SELECT * FROM run ORDER BY created_at,id").all() as Row[])
      .filter(row => !controls.has(`completion-run:${row.id}`) && row.worker_unit !== `completion:${row.id}`);
    if (runs.some(row => ["starting", "running"].includes(row.state))) return failure("Fleet cutover requires every admitted execution to settle under its owning release");
    const threads = new Map<string, ImportThread>(), messages = new Map<string, ImportMessage>();
    for (const row of runs) {
      const custody = parse(controls.get(`run-core:${row.id}`), {});
      const stateDir = custody.coreStateDir;
      const treePath = stateDir && join(stateDir, "pi-tree.json");
      const tree = treePath && existsSync(treePath) ? JSON.parse(readFileSync(treePath, "utf8")) : undefined;
      if (tree && (tree.rootId !== row.id || !Array.isArray(tree.nodes))) return failure(`Invalid fleet native tree ${row.id}`);
      if (tree?.nodes.some((node: Row) => node.busy || node.work && node.work.status !== "complete")) return failure(`Fleet ${row.id} retains unfinished native work`);
      if (tree?.dispatches?.some(([, dispatch]: [string, Row]) => dispatch.state === "pending")) return failure(`Fleet ${row.id} retains unconfirmed dispatch admission`);
      const root = tree?.nodes.find((node: Row) => node.id === row.id);
      const relation = parse(controls.get(`fleet-child:${row.id}`), undefined);
      const model = root?.model ?? row.model ?? relation?.assignment?.model;
      const provider = root?.provider ?? row.provider ?? relation?.assignment?.provider;
      const selected = model && (provider || model.includes("/") || catalogModel(model)) ? resolveThreadSettings({ model: catalogModel(model)?.id ?? (provider ? `${provider}/${model}` : model),
        thinkingLevel: root?.thinkingLevel ?? row.thinking ?? undefined, speed: "standard" })
        : options.settingsForProfile ? { ok: true as const, value: options.settingsForProfile(row.profile) } : resolveThreadSettings({ model: row.profile });
      if (!selected.ok) return selected;
      const context = parse(controls.get(`run-context:${row.id}`), undefined);
      const execution = controls.get(`run-execution:${row.id}`) ?? "user";
      if (context && execution === "root-repair") return failure(`Fleet ${row.id} combines isolated context with root repair`);
      const nativeFile = root?.sessionFile ?? (row.session_file?.endsWith(".jsonl") ? row.session_file : undefined);
      const thread: ImportThread = { id: row.id, parentId: relation?.parentRunId ?? null, title: row.source_id ?? row.profile,
        cwd: root?.cwd ?? row.cwd, sessionFile: nativeFile ?? join(options.sessionsDir, `${row.id}.jsonl`),
        settings: selected.value, admission: relation ? "force" : row.budget, held: row.state === "aborted",
        createdAt: row.created_at, updatedAt: row.updated_at, metadata: { source: row.source, laneId: row.source === "lane" ? row.source_id : undefined,
          profile: row.profile, context, execution, nativeHistoryRequired: Boolean(nativeFile),
          importedFrom: { source: "fleet", id: row.id, nativeStateDirectory: stateDir, accountId: row.account_id, model: row.model, provider: row.provider, sessionFile: row.session_file,
            releasePath: row.release_path, workerUnit: row.worker_unit, failureKind: row.failure_kind, startedAt: row.started_at, endedAt: row.ended_at,
            relationship: relation } } };
      if (threads.has(row.id)) return failure(`Fleet thread ${row.id} has two source owners`);
      threads.set(row.id, thread);
      const outcome: WorkOutcome = row.state === "failed" ? "failed" : row.state === "aborted" ? "cancelled" : "complete";
      const workId = `fleet-input:${row.id}`;
      messages.set(workId, { id: workId, threadId: row.id, senderId: relation?.parentRunId, text: row.prompt,
        state: row.state === "queued" ? "queued" : "done", outcome: row.state === "queued" ? undefined : outcome,
        createdAt: row.created_at, insertedAt: row.started_at ?? undefined, executionId: row.id,
        finalMessage: row.result ? { role: "assistant", content: [{ type: "text", text: row.result }] } : null });
      if (relation && row.state !== "queued" && !controls.has(`fleet-delivered:${row.id}`)) {
        const id = `fleet-result:${row.id}`;
        messages.set(id, { id, threadId: relation.parentRunId, senderId: row.id, source: "notification", delivery: "steer", replyTo: workId,
          text: serializeThreadNotification({ type: "thread_idle", threadId: row.id, workId, outcome, finalMessage: row.result ?? null }) });
      }
      if (tree) importNativeChildren(row.id, tree.nodes, threads, messages);
    }
    const groups = new Map<ThreadService, ImportThread[]>();
    for (const thread of threads.values()) {
      if (thread.metadata?.context && !options.selectService) return failure(`Isolated thread ${thread.id} requires its application owner`);
      const owner = options.selectService?.(thread) ?? service;
      const group = groups.get(owner) ?? []; group.push(thread); groups.set(owner, group);
    }
    for (const [owner, group] of groups) {
      const ids = new Set(group.map(thread => thread.id));
      const imported = owner.importState(group, [...messages.values()].filter(message => ids.has(message.threadId)));
      if (!imported.ok) return imported;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of runs) {
        db.prepare("UPDATE lease SET ended_at=COALESCE(ended_at,?) WHERE run_id=?").run(Date.now(), row.id);
        db.prepare("DELETE FROM run WHERE id=?").run(row.id);
        db.prepare("DELETE FROM control WHERE key='repair-owner' AND value=?").run(row.id);
        for (const prefix of ["run-core:", "run-context:", "run-execution:", "run-environment:", "run-usage:", "fleet-child:", "fleet-waiting:", "fleet-delivered:"])
          db.prepare("DELETE FROM control WHERE key=?").run(prefix + row.id);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    for (const owner of new Set([service, ...groups.keys(), ...(options.services?.() ?? [])])) {
      const finished = finishImport(owner, 0, 0); if (!finished.ok) return finished;
    }
    return { ok: true, value: { threads: threads.size, messages: messages.size } };
  } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
}
