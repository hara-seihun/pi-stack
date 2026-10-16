import { afterEach, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { createCoreCustodyRuntime } from "../src/core/custody.js";
import { createCoreInProcessRuntime } from "../src/core/native-session.js";
import { custodySocket } from "../src/core/custody-socket.js";
import { fileURLToPath } from "node:url";
import type { CoreScope } from "../src/core/contracts.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): CoreScope {
  const root = mkdtempSync(join(tmpdir(), "core-custody-")); roots.push(root);
  const storage = { databasePath: join(root, "threads.sqlite3"), sessionsDir: join(root, "sessions"),
    capabilityKeyPath: join(root, "capability"), adoptionReceiptPath: join(root, "receipt.json") };
  mkdirSync(storage.sessionsDir);
  for (const path of [storage.databasePath, storage.capabilityKeyPath, storage.adoptionReceiptPath]) writeFileSync(path, "original bytes");
  const processStat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const namespace = { kind: "process" as const, pid: process.pid, startTicks: processStat.slice(processStat.lastIndexOf(")") + 2).split(/\s+/)[19]!, mountNamespaceInode: statSync(`/proc/${process.pid}/ns/mnt`, { bigint: true }).ino.toString() };
  return { id: "private", principalId: "fixture", availability: { kind: "adopt" }, resource: { id: "private", owner: "fixture", kind: "thread", privacy: "confidential", subjects: [], consent: "not-required" },
    storage, custody: { uid: process.getuid!(), gid: process.getgid!(), dataDir: root, socketDir: root,
      namespace, retainedRunnerNamespace: namespace },
    environment: {}, resources: [{ path: storage.sessionsDir, kind: "directory" }], callbackGateway: { kind: "none" }, manager: { kind: "none" }, managerRouting: { kind: "none" } };
}
const listen = (server: Server, path: string) => new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));

test("registered old sockets attach through pinned namespace without replacing store bytes or logical references", async () => {
  const scope = fixture();
  mkdirSync(join(scope.custody.socketDir, "thread-runners")); mkdirSync(join(scope.custody.socketDir, "thread-sockets"));
  const reference = { control: join(scope.custody.socketDir, "thread-runners", "1111111111111111.sock"),
    socketPath: join(scope.custody.socketDir, "thread-sockets", "1111111111111111.2222222222222222.sock") };
  let drainAccepted!: () => void;
  const drained = new Promise<void>(resolve => { drainAccepted = resolve; });
  const control = createServer(socket => socket.once("data", data => {
    const request = JSON.parse(data.toString());
    socket.end(JSON.stringify({ ok: true, threadIds: ["accepted"], activeSessions: 1 }) + "\n");
    if (request.type === "drain") drainAccepted();
  }));
  const native = createServer(socket => socket.once("data", () => socket.write(JSON.stringify({ type: "attached" }) + "\n")));
  await listen(control, reference.control); await listen(native, reference.socketPath);
  const before = statSync(scope.storage.databasePath);
  const result = await createCoreCustodyRuntime(scope);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  try {
    const events: unknown[] = [];
    const attached = await result.value.attachSession(reference, event => events.push(event), () => {});
    expect(attached).not.toBeNull();
    expect(events).toContainEqual({ type: "runner_attached", ...reference });
    expect(result.value.path(join(scope.storage.sessionsDir, "new-output.jsonl"))).toBe(join(scope.storage.sessionsDir, "new-output.jsonl"));
    expect(() => result.value.path(join(scope.custody.dataDir, "unregistered"))).toThrow("Unregistered");
    expect(statSync(scope.storage.databasePath).ino).toBe(before.ino);
    expect(readFileSync(scope.storage.databasePath, "utf8")).toBe("original bytes");
  } finally { result.value.detach(); await drained; await close(native); await close(control); }
});

test("exact executable symlink requires its canonical target grant; directory children and retargeting remain fenced", async () => {
  const scope = fixture();
  const home = scope.storage.sessionsDir;
  const executable = join(home, "pi");
  const target = join(scope.custody.dataDir, "immutable-pi.mjs");
  const foreign = join(scope.custody.dataDir, "private-file");
  writeFileSync(target, "executable"); writeFileSync(foreign, "private");
  symlinkSync(target, executable);
  scope.resources.push({ path: executable, kind: "file" });
  const rejected = await createCoreCustodyRuntime(scope);
  expect(rejected.ok).toBe(false);
  scope.resources.push({ path: target, kind: "file" });
  const accepted = await createCoreCustodyRuntime(scope);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) throw new Error(accepted.error.message);
  try {
    expect(accepted.value.path(executable)).toBe(executable);
    const implicit = join(home, "implicit"); symlinkSync(target, implicit);
    expect(() => accepted.value.path(implicit)).toThrow("exact registered target");
    unlinkSync(executable); symlinkSync(foreign, executable);
    expect(() => accepted.value.path(executable)).toThrow("exact registered target");
  } finally { accepted.value.detach(); }
});

test("fixed resource bridge streams large native frames without hosting execution", async () => {
  const scope = fixture();
  mkdirSync(join(scope.custody.socketDir, "thread-runners"));
  const path = join(scope.custody.socketDir, "thread-runners", "3333333333333333.sock");
  const payload = "x".repeat(250000);
  const server = createServer(socket => socket.once("data", () => socket.end(JSON.stringify({ ok: true, payload }) + "\n")));
  await listen(server, path);
  const socket = custodySocket(["/usr/bin/python3", fileURLToPath(new URL("../src/core/custody-bridge.py", import.meta.url)), "socket", path]);
  try {
    const response = await new Promise<any>((resolve, reject) => {
      let data = "";
      socket.on("error", reject);
      socket.on("connect", () => socket.write('{"type":"status"}\n'));
      socket.on("data", chunk => { data += chunk.toString(); const end = data.indexOf("\n"); if (end >= 0) resolve(JSON.parse(data.slice(0, end))); });
    });
    expect(response).toEqual({ ok: true, payload });
  } finally { socket.destroy(); await close(server); }
});

test("ending a completed control observation closes its resource bridge without stopping the native owner", async () => {
  const scope = fixture();
  mkdirSync(join(scope.custody.socketDir, "thread-runners"));
  const path = join(scope.custody.socketDir, "thread-runners", "4444444444444444.sock");
  let nativePeerEnded = false;
  const server = createServer(peer => {
    peer.once("data", () => peer.write('{"ok":true}\n'));
    peer.once("end", () => { nativePeerEnded = true; });
  });
  await listen(server, path);
  const socket = custodySocket(["/usr/bin/python3", fileURLToPath(new URL("../src/core/custody-bridge.py", import.meta.url)), "socket", path]);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => socket.write('{"type":"status"}\n'));
      socket.once("data", () => socket.end());
      socket.once("close", () => resolve());
    });
    expect(nativePeerEnded).toBe(true);
    expect(server.listening).toBe(true);
  } finally { socket.destroy(); await close(server); }
}, 2_000);

test("changed namespace birth is an explicit error before opening resources", async () => {
  const scope = fixture();
  if (scope.custody.namespace.kind === "process") scope.custody.namespace.startTicks = "0";
  const result = await createCoreCustodyRuntime(scope);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain("birth");
});

test("in-process private input rejection is atomic and accepted judgment drains on detach", async () => {
  const runtime = createCoreInProcessRuntime();
  let finish!: () => void, prompted = 0, disposed = 0;
  const judgment = new Promise<void>(resolve => { finish = resolve; });
  runtime.register("root", async () => ({ prompt: async () => { prompted++; await judgment; }, finalMessage: () => ({ role: "assistant", content: [{ type: "text", text: "chosen" }] }), abort: async () => {}, dispose: () => { disposed++; } }));
  const events: any[] = [];
  const session = await runtime.openSession({ threadId: "root", cwd: "/", sessionFile: "/private/root.jsonl", args: [], env: {} }, event => events.push(event), () => {});
  await session.command({ type: "input_batch", id: "bad", batchId: "bad", inputs: [{ workId: "a", message: "first" }, { workId: "b", message: "second" }] });
  expect(prompted).toBe(0); expect(events[0].success).toBe(false);
  await session.command({ type: "input_batch", id: "accepted", batchId: "accepted", inputs: [{ workId: "one", message: "judgment" }] });
  runtime.detach(); expect(prompted).toBe(1); expect(disposed).toBe(0);
  finish(); await runtime.drain();
  expect(events.some(event => event.type === "agent_settled" && event.outcome === "complete" && event.workIds[0] === "one")).toBe(true);
  await session.close(); expect(disposed).toBe(1);
});
