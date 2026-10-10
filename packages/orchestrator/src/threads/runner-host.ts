import { createServer, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, dirname, join } from "node:path";
import { underMemoryPressure } from "./runner-memory.js";
import { RuntimeOutput } from "./runner-output.js";
import { shareFile } from "../shared-custody.js";
import { openPiSession, piEnvironmentScope } from "./pi-session.js";
import type { PiEvent, PiSession, PiSessionOptions } from "./contracts.js";
import { assertNever } from "./runtime-events.js";
import { requireRunnerChannelRequest, requireRunnerControlRequest } from "./runner-protocol.js";

type Resident = { close(): Promise<void>; id: string; key?: string; active: boolean; used: number; pending: number; priority: boolean; background: Set<string>; backgroundCount: number };
const [controlPath] = process.argv.slice(2);
if (!controlPath) throw new Error("Thread runner requires a control socket");
const sessions = new Map<string, Resident>();
let stopping = false, drainWhenEmpty = false;
const shared = process.env.PI_THREAD_RUNNER_RESIDENT !== "0";
let operations = Promise.resolve();
function serial<T>(action: () => Promise<T>): Promise<T> {
  const result = operations.then(action);
  operations = result.then(() => {}, () => {});
  return result;
}
function positive(value: string | undefined, fallback: number) { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : fallback; }
const maxSessions = positive(process.env.PI_THREAD_MAX_ACTIVE_SESSIONS, 64);
const maxResident = positive(process.env.PI_THREAD_MAX_RESIDENT_SESSIONS, maxSessions * 2);
const maxRss = positive(process.env.PI_THREAD_RUNNER_MAX_RSS_MB, 6144) * 1024 * 1024;
const pressure = () => process.memoryUsage().rss >= maxRss || underMemoryPressure();
const activeCount = () => [...sessions.values()].filter(session => session.active).length;
function availableSlots(priority = false) {
  const limit = priority ? maxSessions : Math.min(maxSessions, Math.max(1, maxSessions - 4));
  return stopping || pressure() ? 0 : Math.max(0, limit - activeCount());
}
async function reclaim(reserve = 0, exclude?: Resident) {
  const idle = [...sessions.values()].filter(session => !session.active && !session.pending && !session.background.size && !session.backgroundCount && session !== exclude).sort((a, b) => a.used - b.used);
  for (const session of idle) {
    if (sessions.size + reserve <= maxResident && !pressure()) break;
    try { await session.close(); }
    catch (error) { console.error(`Runner reclamation refused for ${session.id}:`, error); }
    globalThis.gc?.();
  }
}
async function activate(session: Resident) {
  if (!session.active) {
    await reclaim(0, session);
    if (!availableSlots(session.priority)) throw new Error("Runner capacity busy; work remains queued");
    session.active = true;
  }
  session.used = Date.now();
}
function lines(socket: Socket, receive: (value: any) => void) {
  const reader = createInterface({ input: socket, crlfDelay: Infinity });
  reader.on("error", () => socket.destroy());
  reader.on("line", line => {
    try { receive(JSON.parse(line)); }
    catch (error) { socket.end(`${JSON.stringify({ error: String(error) })}\n`); }
  });
  socket.on("error", () => {});
}
function reply(socket: Socket | null, value: unknown) { if (socket?.writable) socket.write(`${JSON.stringify(value)}\n`); }
function remove(path: string) {
  try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function open(options: PiSessionOptions & { socketPath: string; priority?: boolean }) {
  if (stopping) throw new Error("Runner is stopping");
  const existing = sessions.get(options.socketPath);
  if (existing) {
    if (options.env.PI_THREAD_RECOVERING === "1") return;
    if (existing.key === options.env.PI_THREAD_SESSION_KEY) { await activate(existing); return; }
    await existing.close();
  }
  await reclaim(1);
  if (sessions.size >= maxResident || !availableSlots(options.priority)) throw new Error("Runner capacity busy; work remains queued");
  const { socketPath } = options;
  const generation = basename(controlPath, ".sock");
  if (dirname(socketPath) !== join(dirname(controlPath), "..", "thread-sockets") || !basename(socketPath).startsWith(`${generation}.`)) throw new Error("Invalid thread socket");
  const env = { ...options.env };
  const spoolPath = `${socketPath}.events`;
  for (const path of [socketPath, spoolPath]) remove(path);
  const output = new RuntimeOutput(spoolPath);
  let client: Socket | null = null;
  let closed = false;
  let adapter: PiSession;
  let ready: Promise<void>;
  const resident: Resident = { close, id: options.threadId, key: env.PI_THREAD_SESSION_KEY, active: true, used: Date.now(), pending: 0, priority: options.priority !== false, background: new Set(), backgroundCount: 0 };
  const channel = createServer(socket => {
    client?.destroy(); client = socket; socket.setNoDelay(true);
    lines(socket, input => {
      const value = requireRunnerChannelRequest(input);
      switch (value.type) {
        case "attach":
          reply(socket, { type: "attached", pid: process.pid, sequence: output.sequence });
          output.attach(socket, value.after ?? 0); return;
        case "ack": output.acknowledge(value.sequence); return;
        case "command": {
          resident.pending++;
          const observing = /^(?:get_|set_session_name$|set_speed$|set_thinking_level$)/.test(value.value.type);
          void serial(async () => { if (!observing) await activate(resident); else resident.used = Date.now(); await ready; }).then(() => piEnvironmentScope.run(env, () => adapter.command(value.value))).catch(error => publish({
            id: value.value.id, type: "response", command: value.value.type, success: false, error: String(error),
          })).finally(() => { resident.pending--; });
          return;
        }
      }
      assertNever(value);
    });
    socket.on("close", () => { if (client === socket) client = null; });
  });
  function publish(value: PiEvent) {
    if (value.type === "tool_execution_end") {
      const details = (value.result as { details?: { operationId?: string; state?: string } } | undefined)?.details;
      if (details?.operationId && (details.state === "running" || details.state === "accepted")) resident.background.add(details.operationId);
    }
    if (value.type === "tool_operation_result") {
      resident.background.delete(String(value.operationId));
      resident.backgroundCount = resident.background.size;
    }
    if (value.type === "response" && value.command === "get_state" && value.success) resident.backgroundCount = Number((value.data as { backgroundOperationCount?: number })?.backgroundOperationCount ?? 0);
    if (value.type === "response" && value.command === "get_state" && value.success) value = { ...value, data: { ...value.data as object, threadSessionKey: resident.key } };
    if (!closed) output.publish(value);
  }
  function finish(code = 0) {
    if (closed) return;
    closed = true;
    reply(client, { type: "exit", code }); client?.end(); channel.close(); output.close();
    for (const path of [socketPath, spoolPath]) remove(path);
    sessions.delete(socketPath);
    if (!sessions.size && (drainWhenEmpty || !shared) && !stopping) void serial(stop);
  }
  async function close() {
    await ready;
    if (resident.pending) throw new Error("Cannot close a session with unacknowledged commands");
    await piEnvironmentScope.run(env, () => adapter.close());
    finish();
  }
  sessions.set(socketPath, resident);
  try { await new Promise<void>((resolve, reject) => { channel.once("error", reject); channel.listen(socketPath, () => { shareFile(socketPath); resolve(); }); }); }
  catch (error) { finish(1); throw error; }
  ready = piEnvironmentScope.run(env, () => openPiSession(options, publish, finish)).then(value => { adapter = value; }).catch(error => {
    publish({ type: "extension_error", error: String(error) });
    console.error(`Runner thread ${options.threadId}:`, error);
    finish(1);
    throw error;
  });
  try { await ready; }
  catch (error) { throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { nativeNotReady: true }); }
}
const server = createServer(socket => {
  lines(socket, input => {
    const value = requireRunnerControlRequest(input);
    const respond = (operation: Promise<unknown>) => void operation.then(() => reply(socket, { ok: true, pid: process.pid }), error => reply(socket, { error: String(error), ...((error as { nativeNotReady?: boolean }).nativeNotReady ? { nativeNotReady: true } : {}) }));
    switch (value.type) {
      case "open": respond(serial(() => open(value.options))); return;
      case "close": respond(serial(async () => { await sessions.get(value.socketPath)?.close(); })); return;
      case "activity":
        respond(serial(async () => {
          const session = sessions.get(value.socketPath);
          if (!session) throw new Error("Runner capacity busy: idle session was reclaimed; work remains queued");
          if (value.active) await activate(session);
          else { session.active = false; session.used = Date.now(); await reclaim(); }
        })); return;
      case "retain": drainWhenEmpty = false; reply(socket, { ok: true }); return;
      case "drain": drainWhenEmpty = true; reply(socket, { ok: true }); if (!sessions.size) void serial(stop); return;
      case "status":
        reply(socket, { ok: true, historySource: "native-jsonl-v1", pid: process.pid, unit: process.env.PI_THREAD_RUNNER_UNIT ?? null, sessions: sessions.size, activeSessions: activeCount(), availableSlots: availableSlots(true),
          backgroundSlots: availableSlots(false), threadIds: [...sessions.values()].map(session => session.id),
          activeThreadIds: [...sessions.values()].filter(session => session.active).map(session => session.id), maxSessions, maxResident, rss: process.memoryUsage().rss }); return;
    }
    assertNever(value);
  });
});
server.on("error", error => { console.error(error); process.exitCode = 1; });
remove(controlPath);
server.listen(controlPath, () => shareFile(controlPath));
const maintenance = setInterval(() => void serial(() => reclaim()).catch(error => console.error("Runner reclamation failed:", error)), 5000);
maintenance.unref();
async function stop() {
  if (stopping) return;
  stopping = true;
  const results = await Promise.allSettled([...sessions.values()].map(session => session.close()));
  if (results.some(result => result.status === "rejected")) {
    stopping = false;
    console.error("Runner shutdown refused: active sessions still own work");
    return;
  }
  clearInterval(maintenance); server.close(); remove(controlPath);
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => void serial(stop));
