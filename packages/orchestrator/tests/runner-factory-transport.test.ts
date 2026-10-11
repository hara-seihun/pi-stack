import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { RUNNER_FACTORY_PROTOCOL, type RunnerFactoryIdentity } from "../src/threads/runner-factory.js";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { createSharedPiSessionOpener, RunnerFactoryError } from "../src/threads/runner-transport.js";
import { nativeProtocol } from "../src/threads/native-protocol.js";
import type { NativeRunnerOwner } from "../src/threads/runner-ownership.js";
import type { PiEvent } from "../src/threads/contracts.js";
const state = vi.hoisted(() => ({ owner: null as NativeRunnerOwner | null, candidate: null as RunnerFactoryIdentity | null }));
vi.mock("../src/threads/runner-factory.js", async original => ({ ...await original<typeof import("../src/threads/runner-factory.js")>(),
  identifyRunnerFactory: () => ({ ok: true, value: state.candidate }) }));
vi.mock("../src/threads/runner-ownership.js", async original => ({ ...await original<typeof import("../src/threads/runner-ownership.js")>(), nativeStorageOwner: () => state.owner }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: () => { throw new Error("Fixture may not launch native"); } }));
const roots: string[] = [], servers: Server[] = [], sockets: Socket[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) socket.destroy(); for (const server of servers.splice(0)) { await new Promise<void>(resolve => server.close(() => resolve())); } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); state.owner = null; state.candidate = null; });
async function fixture(resident: boolean) {
  const root = mkdtempSync(join(tmpdir(), "factory-transport-")); roots.push(root);
  mkdirSync(join(root, "thread-runners")); mkdirSync(join(root, "thread-sockets"));
  const control = join(root, "thread-runners/aaaaaaaaaaaaaaaa.sock");
  const socketPath = join(root, "thread-sockets/aaaaaaaaaaaaaaaa.3fc4ccfe745870e2.sock"); // sha256("two") prefix
  state.owner = { version: 1, dataDir: root, uid: process.getuid!(), control, pid: process.pid, startTicks: "42" };
  const controls: string[] = [];
  let resolveDrain!: () => void;
  const drained = new Promise<void>(resolve => { resolveDrain = resolve; });
  const server = createServer(socket => { socket.on("data", data => { const request = JSON.parse(data.toString()); controls.push(request.type); if (request.type === "drain") socket.once("close", resolveDrain); socket.end(JSON.stringify({ ok: true, pid: process.pid, sessions: resident ? 1 : 0, activeSessions: resident ? 1 : 0 }) + "\n"); }); });
  servers.push(server); await new Promise<void>(resolve => server.listen(control, resolve));
  if (resident) {
    const channel = createServer(socket => { sockets.push(socket); socket.on("error", () => {}); socket.on("data", () => socket.write(JSON.stringify({ type: "attached", pid: process.pid, sequence: 0 }) + "\n")); });
    servers.push(channel); await new Promise<void>(resolve => channel.listen(socketPath, resolve));
  }
  const events: PiEvent[] = [];
  const opener = createSharedPiSessionOpener({ dataDir: root });
  const open = () => opener.openSession({ threadId: "two", cwd: root, sessionFile: join(root, "two.jsonl"), args: [], env: { PI_THREAD_API_URL: "http://127.0.0.1:1", HOME: root } }, event => events.push(event), () => {});
  return { controls, events, opener, open, control, socketPath, drained };
}

test("discovered old physical owner attaches resident as retained without reopening, capability invention, or replay", async () => {
  const f = await fixture(true);
  const session = await f.open();
  expect(session.nativeOwnership).toMatchObject({ kind: "retained", pid: process.pid, startTicks: "42", reference: { control: f.control, socketPath: f.socketPath } });
  expect(f.controls).toEqual(["status"]);
  expect(nativeProtocol({ acceptedWorkIds: ["original"], landedWorkIds: ["original"], completedWorkIds: [], isStreaming: true }, session.nativeOwnership?.kind === "retained")).toBe("draining");
  f.opener.detach();
  await f.drained;
});

function identity(name: string): RunnerFactoryIdentity { return { entryPath: `/releases/${name}/dist/threads/pi-session.js`, entrySha256: name.repeat(64), sdkDirectory: `/dependencies/${name}`, sourceCommit: name.repeat(40) }; }
async function racingFixture(mode: "concurrent" | "different" | "owner" | "missing-owner" | "ownership-rejection" | "unavailable") {
  const root = mkdtempSync(join(tmpdir(), "factory-race-")); roots.push(root);
  mkdirSync(join(root, "thread-runners")); mkdirSync(join(root, "thread-sockets"));
  const control = join(root, "thread-runners/aaaaaaaaaaaaaaaa.sock");
  const owner: NativeRunnerOwner = { version: 1, dataDir: root, uid: process.getuid!(), control, pid: process.pid, startTicks: "42" };
  state.owner = owner; state.candidate = identity("b");
  let selected = identity("a"), changedOwner = false;
  const commands: any[] = [], upgrades: Socket[] = [], events: PiEvent[] = [];
  let resolveDrain!: () => void;
  const drained = new Promise<void>(resolve => { resolveDrain = resolve; });
  const respond = (socket: Socket, value: unknown) => socket.end(JSON.stringify(value) + "\n");
  const server = createServer(socket => { sockets.push(socket); socket.on("error", () => {}); socket.on("data", data => {
    const request = JSON.parse(data.toString()); commands.push(request);
    if (request.type === "drain") socket.once("close", resolveDrain);
    if (request.type === "status") {
      respond(socket, { ok: true, pid: process.pid, sessions: 1, activeSessions: 1, factoryProtocol: RUNNER_FACTORY_PROTOCOL, futureFactory: selected,
        ...(mode === "missing-owner" && changedOwner ? {} : { nativeOwner: changedOwner ? { ...owner, startTicks: "43" } : owner }) }); return;
    }
    if (request.type === "upgrade_factory") {
      expect(request.owner).toEqual(owner); expect(request.expected).toEqual(identity("a")); expect(request.candidate).toEqual(state.candidate);
      if (mode === "concurrent") {
        upgrades.push(socket);
        if (upgrades.length === 2) {
          selected = state.candidate!;
          respond(upgrades[0]!, { ok: true, current: selected });
          respond(upgrades[1]!, { ok: false, errorCode: "factory-conflict", error: "Current future factory differs from expected predecessor" });
        }
      } else {
        selected = mode === "different" ? identity("c") : state.candidate!;
        changedOwner = mode === "owner" || mode === "missing-owner";
        const errorCode = mode === "ownership-rejection" ? "ownership-conflict" : mode === "unavailable" ? "factory-unavailable" : "factory-conflict";
        respond(socket, { ok: false, errorCode, error: "Rejected predecessor" });
      }
      return;
    }
    respond(socket, { ok: true, pid: process.pid });
  }); });
  servers.push(server); await new Promise<void>(resolve => server.listen(control, resolve));
  for (const id of ["two", "three"]) {
    const path = join(root, `thread-sockets/aaaaaaaaaaaaaaaa.${createHash("sha256").update(id).digest("hex").slice(0, 16)}.sock`);
    const channel = createServer(socket => { sockets.push(socket); socket.on("error", () => {}); socket.on("data", data => {
      const request = JSON.parse(data.toString()); commands.push(request);
      if (request.type === "attach") socket.write(JSON.stringify({ type: "attached", pid: process.pid, sequence: 0 }) + "\n");
    }); });
    servers.push(channel); await new Promise<void>(resolve => channel.listen(path, resolve));
  }
  const opener = createSharedPiSessionOpener({ dataDir: root });
  const open = (threadId: string) => opener.openSession({ threadId, cwd: root, sessionFile: join(root, `${threadId}.jsonl`), args: [], env: { PI_THREAD_API_URL: "http://127.0.0.1:1", HOME: root } }, event => events.push(event), () => {});
  return { open, opener, commands, owner, events, drained };
}

test("concurrent retained opens reconcile the same candidate under the exact owner without retrying CAS or replaying input", async () => {
  const f = await racingFixture("concurrent");
  try {
    const sessions = await Promise.all([f.open("two"), f.open("three")]);
    expect(sessions).toHaveLength(2);
    for (const session of sessions) expect(session.nativeOwnership).toMatchObject({ kind: "retained", pid: f.owner.pid, startTicks: f.owner.startTicks });
    expect(f.commands.filter(command => command.type === "upgrade_factory")).toHaveLength(2);
    expect(f.commands.filter(command => command.type === "open").map(command => command.options.threadId).sort()).toEqual(["three", "two"]);
    expect(f.commands.some(command => command.type === "command")).toBe(false);
    expect(f.events.every(event => event.type === "runner_attached")).toBe(true);
  } finally { f.opener.detach(); await f.drained; }
});

test.each(["different", "owner", "missing-owner", "ownership-rejection", "unavailable"] as const)("a %s conflict never opens work or repeats a factory mutation", async mode => {
  const f = await racingFixture(mode);
  try {
    const error = await f.open("two").catch(error => error);
    const code = mode === "owner" || mode === "ownership-rejection" ? "ownership-conflict" : mode === "missing-owner" ? "ownership-uncertain" : mode === "unavailable" ? "factory-unavailable" : "factory-conflict";
    expect(error.code).toBe(code);
    expect(f.commands.filter(command => command.type === "upgrade_factory")).toHaveLength(1);
    expect(f.commands.some(command => command.type === "open" || command.type === "command")).toBe(false);
  } finally { f.opener.detach(); }
});

test("old physical owner without future socket gives typed finite bootstrap, preserving exact reference", async () => {
  const f = await fixture(false);
  const failure = await f.open().catch(error => error);
  expect(failure).toBeInstanceOf(RunnerFactoryError);
  expect(failure.code).toBe("finite-bootstrap-required");
  expect(f.events).toEqual([{ type: "runner_attached", control: f.control, socketPath: f.socketPath }]);
  expect(f.controls).toEqual(["status"]);
  f.opener.detach();
});
