import { createServer, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, dirname, join } from "node:path";
import { underMemoryPressure } from "./runner-memory.js";
import { RuntimeOutput } from "./runner-output.js";
import { shareFile } from "../shared-custody.js";
import { openPiSession, piEnvironmentScope } from "./pi-session.js";
import type { PiEvent, PiSession, PiSessionOptions } from "./contracts.js";

const [controlPath] = process.argv.slice(2);
if (!controlPath) throw new Error("Thread runner requires a control socket");
const sessions = new Map<string, { close(): Promise<void>; id: string }>();
let stopping = false;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const maxSessions = Number(process.env.PI_THREAD_MAX_ACTIVE_SESSIONS || 64);
const maxRss = Number(process.env.PI_THREAD_RUNNER_MAX_RSS_MB || 6144) * 1024 * 1024;
function availableSlots(priority = false) {
  const limit = priority ? maxSessions : Math.min(maxSessions, Math.max(1, maxSessions - 4));
  return stopping || process.memoryUsage().rss >= maxRss || underMemoryPressure() ? 0 : Math.max(0, limit - sessions.size);
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
  if (sessions.has(options.socketPath)) return;
  if (!availableSlots(options.priority)) throw new Error("Runner capacity busy; work remains queued");
  clearTimeout(idleTimer);
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
  const channel = createServer(socket => {
    client?.destroy(); client = socket; socket.setNoDelay(true);
    lines(socket, value => {
      if (value.type === "attach") {
        reply(socket, { type: "attached", pid: process.pid, sequence: output.sequence });
        output.attach(socket, Number(value.after || 0));
      } else if (value.type === "ack") output.acknowledge(Number(value.sequence));
      else if (value.type === "command") {
        void ready.then(() => piEnvironmentScope.run(env, () => adapter.command(value.value))).catch(error => publish({
          id: value.value?.id, type: "response", command: value.value?.type, success: false, error: String(error),
        }));
      }
    });
    socket.on("close", () => { if (client === socket) client = null; });
  });
  function publish(value: PiEvent) { if (!closed) output.publish(value); }
  function finish(code = 0) {
    if (closed) return;
    closed = true;
    reply(client, { type: "exit", code }); client?.end(); channel.close(); output.close();
    for (const path of [socketPath, spoolPath]) remove(path);
    sessions.delete(socketPath);
    if (!sessions.size && !stopping) idleTimer = setTimeout(() => void stop(), 5000);
  }
  async function close() {
    await ready;
    await piEnvironmentScope.run(env, () => adapter.close());
    finish();
  }
  sessions.set(socketPath, { close, id: options.threadId });
  try { await new Promise<void>((resolve, reject) => { channel.once("error", reject); channel.listen(socketPath, () => { shareFile(socketPath); resolve(); }); }); }
  catch (error) { finish(1); throw error; }
  ready = piEnvironmentScope.run(env, () => openPiSession(options, publish, finish)).then(value => { adapter = value; }).catch(error => {
    publish({ type: "extension_error", error: String(error) });
    console.error(`Runner thread ${options.threadId}:`, error);
    setTimeout(() => finish(1), 100);
    throw error;
  });
  void ready.catch(() => {});
}
const server = createServer(socket => {
  lines(socket, value => {
    if (value.type === "open") void open(value.options).then(() => reply(socket, { ok: true, pid: process.pid }), error => reply(socket, { error: String(error) }));
    else if (value.type === "close") void Promise.resolve(sessions.get(value.socketPath)?.close()).then(() => reply(socket, { ok: true }), error => reply(socket, { error: String(error) }));
    else if (value.type === "status") reply(socket, { ok: true, pid: process.pid, sessions: sessions.size, availableSlots: availableSlots(true),
      backgroundSlots: availableSlots(false), threadIds: [...sessions.values()].map(session => session.id), maxSessions, rss: process.memoryUsage().rss });
    else reply(socket, { error: "Unknown runner command" });
  });
});
server.on("error", error => { console.error(error); process.exitCode = 1; });
remove(controlPath);
server.listen(controlPath, () => shareFile(controlPath));
idleTimer = setTimeout(() => { if (!sessions.size) void stop(); }, 5000);
async function stop() {
  if (stopping) return;
  stopping = true; clearTimeout(idleTimer);
  const results = await Promise.allSettled([...sessions.values()].map(session => session.close()));
  if (results.some(result => result.status === "rejected")) {
    stopping = false;
    console.error("Runner shutdown refused: active sessions still own work");
    return;
  }
  server.close(); remove(controlPath);
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => void stop());
