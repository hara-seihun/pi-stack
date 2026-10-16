import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { MeetResult, MeetThreadState } from "./protocol";

export const MEET_RUNTIME_PROTOCOL = "meet-runtime-v1";
export type RuntimeStatus = { protocol: typeof MEET_RUNTIME_PROTOCOL; revision: string; pid: number;
  instance: string; socketPath?: string; phase: "serving" | "releasing"; requestsInFlight: number; rooms: Array<{ id: string; sessionId: string }> };
export type RuntimeContext = { sessions: string[]; activity: Array<{ meetingId: string; sessionId: string; threads: MeetThreadState[] }> };
export type RuntimeRequest = { url: string; method: string; headers: Array<[string, string]>; body: string | null;
  agentMeetingId: string | null; context: RuntimeContext };
export type RuntimeResponse = { status: number; headers: Array<[string, string]>; body: string };
export type RuntimeRelease = { released: true } | { released: false; reason: "live-rooms" | "requests-in-flight" | "instance-changed" | "releasing" };
export type RuntimeResult<T> = { ok: true; value: T } | { ok: false; kind: "transport" | "protocol" | "operation"; error: string };

export function meetData(): string {
  return process.env.PI_REMOTE_DATA ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "pi-remote");
}
export function meetSocket(data = meetData()): string { return join(data, "meet-runtime.sock"); }
export function runtimeEndpoint(data: string, status: RuntimeStatus): string { return status.socketPath === undefined ? meetSocket(data) : status.socketPath; }
const validRuntimeSocketPath = (path: unknown, instance: string): path is string => typeof path === "string" && isAbsolute(path) && /^[a-f0-9-]{36}$/.test(instance) && basename(path) === `meet-${instance}.sock`;

export function retainedRuntimeEndpoint(data: string): RuntimeResult<{ socket: string; pid: number; instance: string } | null> {
  const path = join(data, "supervisor.sqlite3");
  if (!existsSync(path)) return { ok: true, value: null };
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, strict: true });
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meet_runtime_owner'").get()) return { ok: true, value: null };
    const columns = db.query("PRAGMA table_info(meet_runtime_owner)").all() as Array<{ name: string }>;
    const owner = db.query(`SELECT pid,instance,${columns.some(column => column.name === "socket_path") ? "socket_path" : "NULL AS socket_path"} FROM meet_runtime_owner WHERE singleton=1`).get() as { pid: number; instance: string; socket_path: string | null } | null;
    if (!owner) return { ok: true, value: null };
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.instance !== "string") return { ok: false, kind: "protocol", error: "Meet runtime owner mirror is invalid; no endpoint was replaced" };
    try { process.kill(owner.pid, 0); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ESRCH") return { ok: true, value: null }; throw cause; }
    if (owner.socket_path !== null && !validRuntimeSocketPath(owner.socket_path, owner.instance)) return { ok: false, kind: "protocol", error: "Meet runtime mirror has an invalid generation endpoint" };
    return { ok: true, value: { socket: owner.socket_path === null ? meetSocket(data) : owner.socket_path, pid: owner.pid, instance: owner.instance } };
  } catch (cause) { return { ok: false, kind: "operation", error: `Meet runtime custody is uncertain; no endpoint was replaced: ${String(cause)}` }; }
  finally { db?.close(); }
}

export function runtimeRevision(): string {
  const hash = createHash("sha256").update(realpathSync(import.meta.dir));
  for (const name of readdirSync(import.meta.dir).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort()) {
    hash.update(name).update(readFileSync(join(import.meta.dir, name)));
  }
  for (const name of ["config.ts", "cors.ts"]) hash.update(name).update(readFileSync(join(import.meta.dir, "..", name)));
  return hash.digest("hex");
}

export function initializeRuntimeMirror(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS meet_runtime_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, instance TEXT NOT NULL, socket_path TEXT);
    CREATE TABLE IF NOT EXISTS meet_live_rooms (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, instance TEXT NOT NULL);`);
  if (!(db.query("PRAGMA table_info(meet_runtime_owner)").all() as Array<{ name: string }>).some(column => column.name === "socket_path")) db.exec("ALTER TABLE meet_runtime_owner ADD COLUMN socket_path TEXT");
}

export function parseRuntimeStatus(value: unknown): MeetResult<RuntimeStatus> {
  if (!value || typeof value !== "object") return { ok: false, error: "Meet runtime returned an invalid status" };
  const status = value as RuntimeStatus;
  if (status.protocol !== MEET_RUNTIME_PROTOCOL) return { ok: false, error: "The reachable Meet runtime has an incompatible protocol; its meetings were not touched" };
  if ((status.socketPath !== undefined && !validRuntimeSocketPath(status.socketPath, status.instance)) || typeof status.revision !== "string" || !Number.isSafeInteger(status.pid) || status.pid < 1 || typeof status.instance !== "string"
    || !["serving", "releasing"].includes(status.phase) || !Number.isSafeInteger(status.requestsInFlight) || status.requestsInFlight < 0 || !Array.isArray(status.rooms)
    || status.rooms.some(room => !room || typeof room.id !== "string" || typeof room.sessionId !== "string")) {
    return { ok: false, error: "Meet runtime returned an invalid status" };
  }
  return { ok: true, value: status };
}

export async function runtimeCall<T>(socket: string, path: string, body?: unknown, timeoutMs = 5000): Promise<RuntimeResult<T>> {
  try {
    const response = await fetch(`http://meet-runtime${path}`, { unix: socket, method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
    let reply: unknown;
    try { reply = await response.json(); }
    catch (cause) { return { ok: false, kind: "protocol", error: `Meet runtime ${path} returned invalid JSON: ${String(cause)}` }; }
    if (!reply || typeof reply !== "object" || !("ok" in reply)) return { ok: false, kind: "protocol", error: `Meet runtime ${path} returned an invalid result (${response.status})` };
    const result = reply as MeetResult<T>;
    if (result.ok === true && "value" in result && response.ok) return result;
    if (result.ok === false && typeof result.error === "string") return { ...result, kind: "operation" };
    return { ok: false, kind: "protocol", error: `Meet runtime ${path} returned an invalid result (${response.status})` };
  } catch (cause) { return { ok: false, kind: "transport", error: `Meet runtime ${path} is unavailable: ${String(cause)}` }; }
}

export async function runtimeStatus(socket: string, timeoutMs = 5000): Promise<MeetResult<RuntimeStatus>> {
  const result = await runtimeCall<unknown>(socket, "/runtime/status", undefined, timeoutMs);
  return result.ok ? parseRuntimeStatus(result.value) : result;
}

function startWorker(data: string): MeetResult<ReturnType<typeof Bun.spawn>> {
  let log: number | undefined;
  try {
    mkdirSync(data, { recursive: true, mode: 0o700 });
    log = openSync(join(data, "meet-runtime.log"), "a", 0o600);
    chmodSync(join(data, "meet-runtime.log"), 0o600);
    // The worker owns the explicit host-namespace lock, not a FUSE-view-local inode.
    const worker = Bun.spawn([process.execPath, join(import.meta.dir, "runtime-main.ts")],
      { cwd: process.cwd(), env: { ...process.env, PI_REMOTE_DATA: data }, stdin: "ignore", stdout: log, stderr: log });
    worker.unref();
    return { ok: true, value: worker };
  } catch (cause) { return { ok: false, error: `Could not start Meet runtime: ${String(cause)}` }; }
  finally { if (log !== undefined) closeSync(log); }
}

export async function connectRuntime(data = meetData(), revision = runtimeRevision()): Promise<MeetResult<RuntimeStatus>> {
  let socket = meetSocket(data);
  let reachable = await runtimeCall<unknown>(socket, "/runtime/status", undefined, 500);
  if (!reachable.ok && reachable.kind === "transport") {
    const retained = retainedRuntimeEndpoint(data);
    if (!retained.ok) return retained;
    if (retained.value) {
      socket = retained.value.socket;
      reachable = await runtimeCall<unknown>(socket, "/runtime/status", undefined, 500);
      if (!reachable.ok) return { ok: false, error: `Retained Meet PID ${retained.value.pid} is alive but its endpoint is unavailable; accepted rooms were not touched: ${reachable.error}` };
      const observed = parseRuntimeStatus(reachable.value);
      if (!observed.ok) return observed;
      if (observed.value.pid !== retained.value.pid || observed.value.instance !== retained.value.instance) return { ok: false, error: "Meet endpoint does not match its retained owner; no runtime was replaced" };
    }
  }
  if (reachable.ok) {
    const parsed = parseRuntimeStatus(reachable.value);
    if (!parsed.ok) return parsed;
    if (parsed.value.phase === "serving" && parsed.value.revision === revision) return parsed;
    if (parsed.value.phase === "serving" && parsed.value.rooms.length) return parsed;
    if (parsed.value.phase === "serving") {
      const release = await runtimeCall<RuntimeRelease>(socket, "/runtime/release", { instance: parsed.value.instance });
      if (!release.ok) return release;
      const decision = release.value;
      if (!decision || typeof decision !== "object" || (decision.released !== true && decision.released !== false)
        || (decision.released === false && !["live-rooms", "requests-in-flight", "instance-changed", "releasing"].includes(decision.reason))) {
        return { ok: false, error: "Meet runtime returned an invalid idle-release decision; its meetings were not touched" };
      }
      if (!release.value.released && ["live-rooms", "requests-in-flight"].includes(release.value.reason)) return runtimeStatus(socket);
      if (!release.value.released && release.value.reason === "instance-changed") return connectRuntime(data, revision);
    }
  }
  if (!reachable.ok && reachable.kind !== "transport") return reachable;
  let started = startWorker(data);
  if (!started.ok) return started;
  const startupBudgetMs = 60_000;
  const deadline = Date.now() + startupBudgetMs;
  let last: MeetResult<RuntimeStatus> = { ok: false, error: "Meet runtime did not become ready" };
  while (Date.now() < deadline) {
    const retained = retainedRuntimeEndpoint(data);
    if (!retained.ok) return retained;
    last = await runtimeStatus(retained.value?.socket ?? socket, Math.min(500, Math.max(1, deadline - Date.now())));
    if (last.ok && last.value.phase === "serving") return last;
    await Bun.sleep(25);
    // A contender may have observed the releasing worker before its lifetime lock was relinquished.
    if (started.value.exitCode !== null) {
      if (started.value.exitCode !== 1) return { ok: false, error: `Meet runtime exited during startup (${started.value.exitCode}); see ${join(data, "meet-runtime.log")}` };
      started = startWorker(data);
      if (!started.ok) return started;
    }
  }
  return { ok: false, error: `Meet runtime startup exceeded ${startupBudgetMs / 1000} seconds: ${last.ok ? last.value.phase : last.error}` };
}
