import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { createSharedPiSessionOpener, RunnerFactoryError } from "../src/threads/runner-transport.js";
import { nativeProtocol } from "../src/threads/native-protocol.js";
import type { NativeRunnerOwner } from "../src/threads/runner-ownership.js";
import type { PiEvent } from "../src/threads/contracts.js";
const state = vi.hoisted(() => ({ owner: null as NativeRunnerOwner | null }));
vi.mock("../src/threads/runner-ownership.js", async original => ({ ...await original<typeof import("../src/threads/runner-ownership.js")>(), nativeStorageOwner: () => state.owner }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: () => { throw new Error("Fixture may not launch native"); } }));
const roots: string[] = [], servers: Server[] = [], sockets: Socket[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) socket.destroy(); for (const server of servers.splice(0)) { await new Promise<void>(resolve => server.close(() => resolve())); } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); state.owner = null; });
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

test("old physical owner without future socket gives typed finite bootstrap, preserving exact reference", async () => {
  const f = await fixture(false);
  const failure = await f.open().catch(error => error);
  expect(failure).toBeInstanceOf(RunnerFactoryError);
  expect(failure.code).toBe("finite-bootstrap-required");
  expect(f.events).toEqual([{ type: "runner_attached", control: f.control, socketPath: f.socketPath }]);
  expect(f.controls).toEqual(["status"]);
  f.opener.detach();
});
