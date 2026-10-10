#!/usr/bin/env bun
/** Read-only custody metadata capture. Never prints or exports transcript/watch bodies. */
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { captureNativeHistoryWatermark } from "../packages/orchestrator/src/threads/history.mjs";

type ObjectValue = Record<string, any>;
type Identity = { path: string; dev: string; ino: string };
export type AuxiliaryPlan = { version: 1; phase: "baseline" | "detached"; outputPath: string;
  baselinePath: string | null; baselineSha256: string | null;
  scopes: Array<{ id: string; availability: "available" | "unavailable"; threads: Identity | null; supervisor: Identity | null;
    sessionRoots: string[]; manager: { kind: "supervisor" } | { kind: "none" } | { kind: "existing"; threadId: string };
    managerRouting: ObjectValue; images: ObjectValue | null; duties: ObjectValue | null;
    missingCursor: { kind: "reject" } | { kind: "original-zero"; sourcePath: string; sha256: string };
    detachedReceiptPath: string | null; liveOwner: { pid: number; startTicks: string } | null }> };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function need(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function trusted(path: string): ObjectValue {
  need(isAbsolute(path) && realpathSync(path) === path, "Custody input must be an exact absolute path");
  const stat = lstatSync(path);
  need(stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0, "Custody input must be root-owned and non-writable by other accounts");
  return JSON.parse(readFileSync(path, "utf8"));
}
function liveOwner(owner: { pid: number; startTicks: string } | null) {
  need(owner && Number.isSafeInteger(owner.pid) && owner.pid > 0, "Image baseline requires the original live ingress owner");
  const text = readFileSync(`/proc/${owner.pid}/stat`, "utf8");
  need(text.slice(text.lastIndexOf(")") + 2).split(" ")[19] === owner.startTicks, "Original live ingress owner changed");
  return owner;
}
function identity(spec: Identity) {
  need(isAbsolute(spec.path), "Database path must be absolute");
  const stat = statSync(spec.path, { bigint: true });
  need(stat.isFile() && String(stat.dev) === spec.dev && String(stat.ino) === spec.ino, "Declared database identity changed");
  return { ...spec };
}
function open(spec: Identity): Database {
  identity(spec);
  return new Database(spec.path, { readonly: true, strict: true });
}
function tables(db: Database): Set<string> {
  return new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
}
function rows(db: Database, table: string): ObjectValue[] {
  need(/^[a-z_]+$/.test(table), "Invalid table name");
  return db.query(`SELECT * FROM ${table}`).all() as ObjectValue[];
}
function digestRows(db: Database, table: string) {
  const values = rows(db, table);
  return { table, count: values.length, rows: values.map(row => ({ id: row.id ?? row.thread_id ?? null, sha256: hash(JSON.stringify(row)) })) };
}
function cursor(db: Database, key: string, policy: AuxiliaryPlan["scopes"][number]["missingCursor"]) {
  const row = db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null;
  if (row) {
    need(/^(0|[1-9][0-9]*)$/.test(row.value) && Number.isSafeInteger(Number(row.value)), "Invalid original notification cursor");
    return { value: Number(row.value), provenance: "stored", key };
  }
  need(policy.kind === "original-zero", `Missing original cursor ${key}; an explicit original-source default proof is required`);
  const source = readFileSync(policy.sourcePath);
  need(hash(source) === policy.sha256 && source.toString().includes(key.split(":")[0]) && /\?\?\s*0\)/.test(source.toString()), "Original cursor default source proof does not match");
  return { value: 0, provenance: "original-source-default", key, sourceSha256: policy.sha256 };
}
type NativeSource = { id: string; session_file: string; created_at: number; scopeId: string; sessionRoots: string[] };
function imageThreadSources(plan: AuxiliaryPlan, scope: AuxiliaryPlan["scopes"][number], own: Array<{ id: string; session_file: string; created_at: number }>): NativeSource[] {
  const ids = scope.images!.relatedThreadScopeIds;
  need(Array.isArray(ids) && new Set(ids).size === ids.length && !ids.includes(scope.id), "Image related thread scopes must be explicit and distinct");
  const result = own.map(row => ({ id: row.id, session_file: row.session_file, created_at: row.created_at, scopeId: scope.id, sessionRoots: scope.sessionRoots }));
  for (const id of ids) {
    const source = plan.scopes.find(candidate => candidate.id === id);
    need(source, "Unregistered related image source");
    if (source.availability === "unavailable") continue;
    need(source.threads, "Related image source lacks its database identity");
    const db = open(source.threads);
    try {
      const values = db.query("SELECT id,session_file,created_at FROM thread ORDER BY id").all() as Array<{ id: string; session_file: string; created_at: number }>;
      result.push(...values.map(row => ({ ...row, scopeId: id, sessionRoots: source.sessionRoots })));
    } finally { db.close(); }
  }
  need(new Set(result.map(row => row.id)).size === result.length, "Image source thread identity overlaps declared owners");
  return result;
}
export type CaptureProgress = { scopeId: string; stage: "scope" | "native-source"; sourceIndex: number; sourceCount: number; threadId: string | null };
export function captureAuxiliary(plan: AuxiliaryPlan, progress?: (value: CaptureProgress) => void) {
  need(plan.version === 1 && ["baseline", "detached"].includes(plan.phase) && Array.isArray(plan.scopes), "Invalid auxiliary plan");
  const startedAt = new Date().toISOString();
  const prior = plan.phase === "detached" ? (() => {
    need(plan.baselinePath && plan.baselineSha256, "Detached capture requires its original live-ingress baseline");
    const value = trusted(plan.baselinePath);
    need(hash(readFileSync(plan.baselinePath)) === plan.baselineSha256 && value.phase === "baseline", "Baseline custody changed");
    return value;
  })() : null;
  const scopes: ObjectValue[] = [], evidence: ObjectValue[] = [], registries: ObjectValue[] = [], entries: ObjectValue[] = [];
  const seen = new Set<string>();
  for (const scope of plan.scopes) {
    progress?.({ scopeId: scope.id, stage: "scope", sourceIndex: 0, sourceCount: 0, threadId: null });
    need(scope.id && !seen.has(scope.id), "Duplicate or absent scope identity"); seen.add(scope.id);
    if (scope.availability === "unavailable") {
      need(scope.manager.kind !== "supervisor", "Unavailable scope requires an explicit retained manager declaration");
      scopes.push({ id: scope.id, manager: scope.manager, managerRouting: scope.managerRouting });
      if (scope.images) registries.push(scope.images);
      if (scope.duties) entries.push(scope.duties);
      evidence.push({ id: scope.id, state: "unavailable", touched: false });
      continue;
    }
    need(scope.availability === "available" && scope.threads, "Available scope requires an exact thread database");
    const threadDb = open(scope.threads), supervisor = scope.supervisor ? open(scope.supervisor) : null;
    try {
      threadDb.exec("BEGIN"); supervisor?.exec("BEGIN");
      const threadTables = tables(threadDb), supervisorTables = supervisor ? tables(supervisor) : new Set<string>();
      need(threadTables.has("thread"), "Original thread schema absent");
      const threads = threadDb.query("SELECT id,session_file,held,metadata,created_at FROM thread ORDER BY id").all() as Array<{ id: string; session_file: string; held: number; metadata: string; created_at: number }>;
      const retained = threads.map(row => { const metadata = JSON.parse(row.metadata); return { id: row.id, held: row.held === 1, archived: metadata.archived === true, manager: metadata.manager === true }; });
      let manager: ObjectValue = scope.manager;
      if (scope.manager.kind === "supervisor") {
        need(supervisor && supervisorTables.has("manager_view"), "Original manager view absent");
        const row = supervisor.query("SELECT thread_id,initialized,view FROM manager_view WHERE singleton=1").get() as { thread_id: string | null; initialized: number; view: string } | null;
        need(row && (row.initialized === 0 || row.initialized === 1), "Invalid original manager view");
        need(row.thread_id !== null || row.initialized === 0 && row.view === "classic", "Original manager identity missing");
        manager = row.thread_id === null ? { kind: "none" } : { kind: "existing", threadId: row.thread_id };
      }
      if (manager.kind === "existing") need(retained.some(row => row.id === manager.threadId), "Selected manager belongs to another thread owner; declare it in canonical relay instead");
      if (manager.kind === "none") need(!retained.some(row => row.manager) || scope.managerRouting.kind === "configured" && scope.managerRouting.relay?.canonicalManager !== null && scope.managerRouting.relay?.canonicalManager !== undefined, "Manager metadata exists; cannot declare no manager without an explicit canonical remote owner");
      let routing = scope.managerRouting;
      const cursorEvidence: ObjectValue[] = [];
      if (routing.kind === "configured") {
        need(supervisor && supervisorTables.has("metadata"), "Notification custody requires original supervisor metadata");
        const owner = routing.notices.notificationOwnerId;
        need(typeof owner === "string" && owner.length > 0, "Original notification owner must be declared");
        const adoptedCursors: ObjectValue = {};
        for (const [field, prefix] of [["settlements", "thread-settlements"], ["attention", "thread-attention"], ["questions", "thread-questions"]]) {
          const observed = cursor(supervisor, `${prefix}:${owner}`, scope.missingCursor);
          adoptedCursors[field!] = observed.value; cursorEvidence.push(observed);
        }
        const origins = (supervisor.query("SELECT key,value FROM metadata WHERE key LIKE 'manager-origin:%' ORDER BY key").all() as Array<{ key: string; value: string }>).map(row => ({ threadId: row.key.slice("manager-origin:".length), environmentId: row.value }));
        routing = { ...routing, relay: { ...routing.relay, adoptedOrigins: origins }, notices: { notificationOwnerId: owner, adoptedCursors } };
      } else need(routing.kind === "none", "Explicit manager routing required");
      const watchStores = [{ db: threadDb, tables: threadTables, path: scope.threads.path }, ...(supervisor ? [{ db: supervisor, tables: supervisorTables, path: scope.supervisor!.path }] : [])].filter(store => store.tables.has("watch_item"));
      need(watchStores.length <= 1, "Multiple original watch stores require separate explicit scope custody");
      const watchStore = watchStores[0];
      const watch = watchStore ? ["watch_item", "watch_request", "watch_wake", "watch_delivery", "watch_schedule"].map(table => {
        need(watchStore.tables.has(table), "Incomplete original watch custody"); return digestRows(watchStore.db, table);
      }) : null;
      need(!watchStore || scope.duties?.watch?.kind === "existing" && scope.duties.watch.databasePath === watchStore.path, "Original watch custody requires its exact configured existing-store duty owner");
      if (scope.duties) { need(scope.duties.scopeId === scope.id, "Duty scope mismatch"); entries.push(scope.duties); }
      let imageSources: ObjectValue[] | null = null;
      let imageThreads: NativeSource[] | null = null;
      if (scope.images) {
        need(supervisor && scope.images.scopeId === scope.id && scope.images.databasePath === scope.supervisor!.path, "Image owner must retain exact supervisor database");
        for (const table of ["inline_images", "inline_image_versions", "inline_image_messages"]) need(supervisorTables.has(table), "Original image schema absent");
        registries.push(scope.images);
        imageThreads = imageThreadSources(plan, scope, threads);
        if (plan.phase === "baseline") {
          liveOwner(scope.liveOwner);
          imageSources = [];
          for (const [sourceIndex, thread] of imageThreads.entries()) {
            progress?.({ scopeId: scope.id, stage: "native-source", sourceIndex, sourceCount: imageThreads.length, threadId: thread.id });
            need(thread.sessionRoots.some(root => isAbsolute(root) && (resolve(thread.session_file) === resolve(root) || resolve(thread.session_file).startsWith(resolve(root) + sep))), "Native source escapes registered session roots");
            const indexed = captureNativeHistoryWatermark(thread.session_file);
            if (!indexed.ok) {
              if (indexed.error.code === "missing") { imageSources.push({ threadId: thread.id, path: thread.session_file, revision: "unstarted", lastOffset: -1, lastDigest: "", priorSource: { kind: "absent", observedAt: new Date().toISOString() } }); continue; }
              throw new Error(`Native watermark unavailable: ${indexed.error.code}`);
            }
            imageSources.push({ threadId: thread.id, path: thread.session_file, ...indexed.value });
          }
          liveOwner(scope.liveOwner);
        } else {
          const baseline = prior!.evidence.find((item: ObjectValue) => item.id === scope.id);
          need(baseline && baseline.threads?.path === scope.threads.path && baseline.supervisor?.path === scope.supervisor?.path && Array.isArray(baseline.nativeImageSources), "No original live-ingress image baseline for scope");
          imageSources = [...baseline.nativeImageSources];
          need(Array.isArray(baseline.nativeImageThreads), "Baseline lacks exact related source identities");
          const initialIds = new Set(baseline.nativeImageThreads.map((row: ObjectValue) => row.id));
          for (const thread of imageThreads) if (!initialIds.has(thread.id)) {
            need(Number.isFinite(thread.created_at) && thread.created_at >= Date.parse(prior!.startedAt), "New source lacks post-baseline creation evidence");
            need(thread.sessionRoots.some(root => isAbsolute(root) && resolve(thread.session_file).startsWith(resolve(root) + sep)), "New native source escapes registered roots");
            imageSources!.push({ threadId: thread.id, path: thread.session_file, revision: "created-after-baseline", lastOffset: -1, lastDigest: "", priorSource: { kind: "created-after-baseline", createdAt: new Date(thread.created_at).toISOString(), baselineStartedAt: prior!.startedAt } });
          }
        }
      } else need(!supervisorTables.has("inline_images") || plan.scopes.some(candidate => candidate.id !== scope.id && candidate.images?.databasePath === scope.supervisor?.path), "Original image registry requires an explicit owner; cannot disable it");
      let detached: ObjectValue | null = null;
      if (plan.phase === "detached") {
        need(scope.detachedReceiptPath, "Final auxiliary capture requires original owner detachment evidence");
        const receipt = trusted(scope.detachedReceiptPath);
        need(receipt.state === "detached" && receipt.scopeId === scope.id && receipt.previousOwner?.identity && Number.isFinite(Date.parse(receipt.previousOwner.detachedAt)), "Invalid original scope detachment receipt");
        need(receipt.databasePath === scope.threads.path && String(receipt.databaseIdentity?.dev) === scope.threads.dev && String(receipt.databaseIdentity?.ino) === scope.threads.ino, "Detached receipt database identity mismatch");
        detached = { path: scope.detachedReceiptPath, sha256: hash(readFileSync(scope.detachedReceiptPath)) };
      }
      scopes.push({ id: scope.id, manager, managerRouting: routing });
      evidence.push({ id: scope.id, state: plan.phase, threads: identity(scope.threads), supervisor: scope.supervisor ? identity(scope.supervisor) : null,
        retained, cursorEvidence, watch, wakes: threadTables.has("thread_wake") ? digestRows(threadDb, "thread_wake") : null,
        nativeImageSources: imageSources, nativeImageThreads: imageThreads, liveOwner: plan.phase === "baseline" && scope.images ? scope.liveOwner : null, detached, imageTableNames: scope.images ? ["inline_images", "inline_image_versions", "inline_image_messages", "core_image_acceptance", "core_image_sources", "core_image_ingress_errors", "core_image_threads"] : null });
      supervisor?.exec("COMMIT"); threadDb.exec("COMMIT");
    } finally { supervisor?.close(); threadDb.close(); }
  }
  return { version: 1, phase: plan.phase, startedAt, capturedAt: new Date().toISOString(), baselineSha256: plan.baselineSha256,
    scopes, images: registries.length ? { kind: "configured", registries } : { kind: "disabled" }, duties: entries.length ? { kind: "configured", entries } : { kind: "disabled" }, evidence };
}
function publish(path: string, value: ObjectValue) {
  need(isAbsolute(path), "Output path must be absolute");
  const parent = lstatSync(dirname(path));
  need(parent.isDirectory() && parent.uid === 0 && (parent.mode & 0o077) === 0 && realpathSync(dirname(path)) === dirname(path), "Output parent must be protected root custody");
  const text = JSON.stringify(value, null, 2) + "\n", temp = `${path}.${randomUUID()}`;
  writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
  const fd = openSync(temp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const dir = openSync(dirname(path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
  return { path, sha256: hash(text) };
}
export function runAuxiliary(planPath: string) {
  need(process.getuid?.() === 0, "Auxiliary CLI requires root custody");
  const plan = trusted(planPath) as AuxiliaryPlan;
  const runPath = `${plan.outputPath}.run.json`, runId = randomUUID();
  const provenance = { version: 1, runId, pid: process.pid, planPath, planSha256: hash(readFileSync(planPath)), startedAt: new Date().toISOString() };
  let progress: CaptureProgress | null = null, lastPublished = 0;
  const record = (state: string, result: ObjectValue = {}) => publish(runPath, { ...provenance, state, progress, updatedAt: new Date().toISOString(), ...result });
  record("running");
  try {
    const captured = captureAuxiliary(plan, value => {
      progress = value;
      if (value.stage === "scope" || Date.now() - lastPublished >= 1000) { record("running"); lastPublished = Date.now(); }
    });
    const value = { ...publish(plan.outputPath, captured), scopes: captured.scopes.length, phase: captured.phase };
    record("complete", { output: value });
    return { ok: true as const, value };
  } catch (error) {
    const failure = { code: "auxiliary-capture-unavailable", message: error instanceof Error ? error.message : String(error) };
    record("failed", { error: failure });
    return { ok: false as const, error: failure, runPath };
  }
}
if (import.meta.main) {
  try {
    need(process.argv.length === 3, "Usage: root bun deploy/core-auxiliary.ts /absolute/protected-plan.json");
    const result = runAuxiliary(process.argv[2]!);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 75;
  } catch (error) { console.log(JSON.stringify({ ok: false, error: { code: "auxiliary-capture-unavailable", message: error instanceof Error ? error.message : String(error) } })); process.exitCode = 75; }
}
