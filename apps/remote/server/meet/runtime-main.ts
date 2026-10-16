import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { applyLocalConfig } from "../config";
import { initializeRuntimeMirror, MEET_RUNTIME_PROTOCOL, meetData, retainedRuntimeEndpoint, runtimeRevision } from "./runtime";
import { MeetSocketOwner, proveSocketAbsent } from "./runtime-socket";
import type { RuntimeContext, RuntimeRequest, RuntimeResponse, RuntimeStatus } from "./runtime";
import type { MeetResult } from "./protocol";

const failure = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
const success = (value: unknown) => Response.json({ ok: true, value });
const validContext = (value: unknown): value is RuntimeContext => {
  if (!value || typeof value !== "object") return false;
  const context = value as RuntimeContext;
  return Array.isArray(context.sessions) && context.sessions.every(id => typeof id === "string") && Array.isArray(context.activity)
    && context.activity.every(item => item && typeof item.meetingId === "string" && typeof item.sessionId === "string" && Array.isArray(item.threads));
};

async function runMeetRuntime(): Promise<MeetResult<void>> {
  const startupCleanup: Array<() => void | Promise<void>> = [];
  try {
    applyLocalConfig();
    const { MeetServer } = await import("./server");
    process.umask(0o077);
    const data = meetData();
    mkdirSync(data, { recursive: true, mode: 0o700 });
    const locked = MeetSocketOwner.acquire(join(data, "meet-runtime.sock"), process.env.PI_CORE_CALLBACK_SOCKET, process.getuid!());
    if (!locked.ok) { console.error(locked.error); process.exit(locked.kind === "occupied" ? 1 : 2); }
    const retained = retainedRuntimeEndpoint(data);
    if (!retained.ok || retained.value) {
      locked.value.close();
      console.error(retained.ok ? `Meet runtime PID ${retained.value!.pid} still owns accepted rooms; startup did not touch it` : retained.error);
      process.exit(1);
    }
    const endpoint = locked.value;
    const instance = endpoint.instance;
    startupCleanup.push(() => endpoint.close());
    const absent = await proveSocketAbsent(endpoint.socket);
    if (!absent.ok) throw new Error(absent.error);
    const socket = endpoint.endpoint;
    const db = new Database(join(data, "supervisor.sqlite3"), { create: true, strict: true });
    startupCleanup.push(() => db.close());
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    initializeRuntimeMirror(db);
    startupCleanup.push(() => { db.query("DELETE FROM meet_runtime_owner WHERE instance=?").run(instance); });
    const revision = runtimeRevision();
    const context = new AsyncLocalStorage<RuntimeContext>();
    const meet = new MeetServer(id => context.getStore()?.sessions.includes(id) === true, undefined, db,
      (meetingId, sessionId) => {
        const observed = context.getStore()?.activity.find(item => item.meetingId === meetingId && item.sessionId === sessionId);
        if (!observed) throw new Error("Meeting activity was not supplied by its supervisor");
        return observed.threads;
      },
      undefined, event => {
        if (event.kind === "created") db.query("INSERT INTO meet_live_rooms(id,session_id,instance) VALUES(?,?,?)").run(event.id, event.sessionId, instance);
        else db.query("DELETE FROM meet_live_rooms WHERE id=? AND instance=?").run(event.id, instance);
      });
    startupCleanup.push(() => meet.close());
    let phase: RuntimeStatus["phase"] = "serving";
    let inFlight = 0;
    let shutdown: Promise<void> | null = null;
    const stopIdle = async () => {
      await meet.close();
      await server.stop(true);
      endpoint.close();
      db.query("DELETE FROM meet_runtime_owner WHERE instance=?").run(instance);
      db.close();
      process.exit(0);
    };
    const scheduleStop = () => {
      setTimeout(() => {
        shutdown = stopIdle();
        shutdown.catch(cause => { console.error("Meet runtime idle cleanup failed", cause); process.exit(2); });
      }, 25);
    };
    const server = Bun.serve({ unix: socket, maxRequestBodySize: 16 * 1024 * 1024,
      async fetch(req): Promise<Response> {
        server.timeout(req, 120);
        const path = new URL(req.url).pathname;
        if (path === "/runtime/status" && req.method === "GET") return success({ protocol: MEET_RUNTIME_PROTOCOL, revision, pid: process.pid,
          instance, socketPath: endpoint.endpoint, phase, requestsInFlight: inFlight, rooms: meet.liveRooms() } satisfies RuntimeStatus);
        if (path === "/runtime/release" && req.method === "POST") {
          let body: unknown;
          try { body = await req.json(); } catch { return failure("Invalid runtime release request"); }
          if (!body || typeof body !== "object" || !("instance" in body) || typeof body.instance !== "string") return failure("A runtime instance is required");
          if (body.instance !== instance) return success({ released: false, reason: "instance-changed" });
          if (phase === "releasing") return success({ released: false, reason: "releasing" });
          if (meet.liveRooms().length) return success({ released: false, reason: "live-rooms" });
          if (inFlight) return success({ released: false, reason: "requests-in-flight" });
          phase = "releasing";
          scheduleStop();
          return success({ released: true });
        }
        if (phase !== "serving") return failure("Meet runtime is releasing an idle worker; reconnect", 503);
        if (req.method !== "POST") return failure("Unknown Meet runtime operation", 404);
        inFlight++;
        try {
          const body = await req.json();
          if (path === "/runtime/request") {
            const input = body as RuntimeRequest;
            if (!input || typeof input.url !== "string" || typeof input.method !== "string" || !Array.isArray(input.headers)
              || input.headers.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== "string"))
              || (input.body !== null && typeof input.body !== "string")
              || (input.agentMeetingId !== null && typeof input.agentMeetingId !== "string") || !validContext(input.context)) return failure("Invalid Meet request envelope");
            const original = new Request(input.url, { method: input.method, headers: input.headers,
              ...(input.body === null ? {} : { body: Buffer.from(input.body, "base64") }) });
            if (input.agentMeetingId === null && !/^\/v1\/meet(?:\/|$)/.test(new URL(original.url).pathname)) return failure("Runtime accepts only Meet routes", 404);
            const response = await context.run(input.context, () => input.agentMeetingId === null ? meet.handle(original) : meet.handleAgent(original, input.agentMeetingId));
            if (!response) return failure("Unknown Meet route", 404);
            return success({ status: response.status, headers: [...response.headers], body: Buffer.from(await response.arrayBuffer()).toString("base64") } satisfies RuntimeResponse);
          }
          if (!body || typeof body !== "object" || typeof body.id !== "string" || !body.id) return failure("Meeting identity is required");
          switch (path) {
            case "/runtime/flush": await meet.flushTranscript(body.id); return success(null);
            case "/runtime/capture": return success(meet.captureDelegation(body.id));
            case "/runtime/stop-external": meet.stopExternal(body.id); return success(null);
            case "/runtime/open-external": {
              if (typeof body.sessionId !== "string" || typeof body.apiUrl !== "string" || typeof body.platformTranscript !== "boolean" || !validContext(body.context)
                || !body.context.sessions.includes(body.sessionId)) return failure("The meeting's Pi Remote thread is unavailable");
              const existing = meet.liveRooms().find(room => room.id === body.id);
              if (existing && existing.sessionId !== body.sessionId) return failure("Meeting belongs to another thread", 409);
              return success(context.run(body.context, () => meet.openExternal(body.id, body.sessionId, body.apiUrl, body.platformTranscript)));
            }
          }
          return failure("Unknown Meet runtime operation", 404);
        } catch (cause) { return failure(`Meet runtime operation failed: ${String(cause)}`, 500); }
        finally { inFlight--; }
      },
    });
    startupCleanup.push(async () => { await server.stop(true); });
    endpoint.captureBoundEndpoint();
    db.transaction(() => {
      db.query("DELETE FROM meet_live_rooms").run();
      db.query("INSERT INTO meet_runtime_owner(singleton,pid,instance,socket_path) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET pid=excluded.pid,instance=excluded.instance,socket_path=excluded.socket_path").run(process.pid, instance, endpoint.endpoint);
    })();
    const published = await endpoint.publish();
    if (!published.ok) throw new Error(published.error);
    for (const signal of ["SIGUSR2", "SIGHUP"] as const) process.on(signal, () => {});
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
      // Release activation never signals this owner. TERM/INT are explicit service shutdown.
      if (phase === "serving") { phase = "releasing"; scheduleStop(); }
    });
    return { ok: true, value: undefined };
  } catch (cause) {
    const failures: string[] = [];
    for (const close of startupCleanup.reverse()) try { await close(); } catch (failure) { failures.push(String(failure)); }
    return { ok: false, error: `Meet runtime startup failed: ${String(cause)}${failures.length ? `; cleanup: ${failures.join("; ")}` : ""}` };
  }
}

const started = await runMeetRuntime();
if (!started.ok) { console.error(started.error); process.exit(2); }
