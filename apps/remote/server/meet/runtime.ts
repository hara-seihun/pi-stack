import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MeetResult, MeetThreadState } from "./protocol";

export const MEET_RUNTIME_PROTOCOL = "meet-runtime-v1";
export type RuntimeStatus = { protocol: typeof MEET_RUNTIME_PROTOCOL; revision: string; pid: number;
  instance: string; phase: "serving" | "releasing"; requestsInFlight: number; rooms: Array<{ id: string; sessionId: string }> };
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

export function runtimeRevision(): string {
  const hash = createHash("sha256").update(realpathSync(import.meta.dir));
  for (const name of readdirSync(import.meta.dir).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort()) {
    hash.update(name).update(readFileSync(join(import.meta.dir, name)));
  }
  for (const name of ["config.ts", "write.ts", "cors.ts"]) hash.update(name).update(readFileSync(join(import.meta.dir, "..", name)));
  return hash.digest("hex");
}

export function initializeRuntimeMirror(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS meet_runtime_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, instance TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meet_live_rooms (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, instance TEXT NOT NULL);`);
}

export function parseRuntimeStatus(value: unknown): MeetResult<RuntimeStatus> {
  if (!value || typeof value !== "object") return { ok: false, error: "Meet runtime returned an invalid status" };
  const status = value as RuntimeStatus;
  if (status.protocol !== MEET_RUNTIME_PROTOCOL) return { ok: false, error: "The reachable Meet runtime has an incompatible protocol; its meetings were not touched" };
  if (typeof status.revision !== "string" || !Number.isSafeInteger(status.pid) || status.pid < 1 || typeof status.instance !== "string"
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

function startWorker(data: string, socket: string): MeetResult<ReturnType<typeof Bun.spawn>> {
  let log: number | undefined;
  try {
    mkdirSync(data, { recursive: true, mode: 0o700 });
    log = openSync(join(data, "meet-runtime.log"), "a", 0o600);
    chmodSync(join(data, "meet-runtime.log"), 0o600);
    // flock holds ownership for the worker's entire lifetime, including between supervisor processes.
    const worker = Bun.spawn(["flock", "--exclusive", "--nonblock", `${socket}.lock`, process.execPath, join(import.meta.dir, "runtime-main.ts")],
      { cwd: process.cwd(), env: { ...process.env, PI_REMOTE_DATA: data }, stdin: "ignore", stdout: log, stderr: log });
    worker.unref();
    return { ok: true, value: worker };
  } catch (cause) { return { ok: false, error: `Could not start Meet runtime: ${String(cause)}` }; }
  finally { if (log !== undefined) closeSync(log); }
}

export async function connectRuntime(data = meetData(), revision = runtimeRevision()): Promise<MeetResult<RuntimeStatus>> {
  const socket = meetSocket(data);
  const reachable = await runtimeCall<unknown>(socket, "/runtime/status", undefined, 500);
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
  let started = startWorker(data, socket);
  if (!started.ok) return started;
  const deadline = Date.now() + 5000;
  let last: MeetResult<RuntimeStatus> = { ok: false, error: "Meet runtime did not become ready" };
  while (Date.now() < deadline) {
    last = await runtimeStatus(socket, Math.min(500, Math.max(1, deadline - Date.now())));
    if (last.ok && last.value.phase === "serving") return last;
    await Bun.sleep(25);
    // A contender may have observed the releasing worker before its lifetime lock was relinquished.
    if (started.value.exitCode !== null) {
      if (started.value.exitCode !== 1) return { ok: false, error: `Meet runtime exited during startup (${started.value.exitCode}); see ${join(data, "meet-runtime.log")}` };
      started = startWorker(data, socket);
      if (!started.ok) return started;
    }
  }
  return { ok: false, error: `Meet runtime startup exceeded five seconds: ${last.ok ? last.value.phase : last.error}` };
}
