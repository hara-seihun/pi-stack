import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { installRunnerFactoryBootstrap, type BootstrapResidentFact } from "../src/threads/runner-factory-bootstrap.js";
import { RUNNER_FACTORY_PROTOCOL, type RunnerFactoryBinding } from "../src/threads/runner-factory.js";

function binding(name: string): RunnerFactoryBinding {
  return { identity: { entryPath: `/releases/${name.repeat(40)}/dist/threads/pi-session.js`, entrySha256: name.repeat(64), sdkDirectory: `/sdk/${name}`, sourceCommit: name.repeat(40) },
    module: { runnerFactoryProtocol: RUNNER_FACTORY_PROTOCOL, runnerSdkDirectory: `/sdk/${name}`, piEnvironmentScope: new AsyncLocalStorage(),
      openPiSession: vi.fn(), runnerProjectionContinuity: () => true } };
}
async function peer(path: string) {
  const socket = createConnection(path), values: any[] = [], readers: ((value: any) => void)[] = [];
  createInterface({ input: socket }).on("line", line => { const value = JSON.parse(line); const read = readers.shift(); if (read) read(value); else values.push(value); });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return { socket, read: () => values.length ? Promise.resolve(values.shift()) : new Promise<any>(resolve => readers.push(resolve)) };
}

test("finite additive bootstrap intercepts fragmented/coalesced upgrades while preserving original listeners, residents, old facade and pre-existing connections", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-bootstrap-")); mkdirSync(join(root, "controls")); const path = join(root, "controls/native.sock");
  const forwarded: string[] = [], sockets: Socket[] = [];
  const predecessorListener = (socket: Socket) => {
    sockets.push(socket); socket.on("error", () => {});
    createInterface({ input: socket }).on("line", line => {
      const request = JSON.parse(line); forwarded.push(request.type);
      if (request.type === "status") socket.write(JSON.stringify({ ok: true, pid: process.pid, sessions: 1, activeSessions: 1 }) + "\n");
      else socket.write(JSON.stringify({ ok: true, original: request.type }) + "\n");
    });
  };
  const server = createServer(predecessorListener);
  await new Promise<void>(resolve => server.listen(path, resolve));
  const before = await peer(path);
  const old = binding("a"), next = binding("b"), facade = { sdk: old.module }, originalFacade = facade.sdk;
  const resident = { id: "accepted", close: vi.fn(), command: vi.fn(), active: true, pending: 2 };
  const facts: BootstrapResidentFact[] = [{ threadId: resident.id, kind: "identified", factory: old.identity,
    evidence: { kind: "adapter-function-location", sourcePath: old.identity.entryPath, sourceSha256: old.identity.entrySha256, line: 3, column: 4 } }];
  let owned = true, queue = Promise.resolve();
  const options = { server, owner: { version: 1 as const, dataDir: root, uid: process.getuid!(), control: path, pid: process.pid, startTicks: "42" },
    leaseEvidence: { bridgePid: 99, bridgeStartTicks: "41", holders: [{ pid: 99, startTicks: "41" }] },
    assertLease: () => { if (!owned) throw new Error("original bridge lease changed"); },
    serial: <T>(action: () => Promise<T>) => { const result = queue.then(action); queue = result.then(() => {}, () => {}); return result; },
    initial: old, initialEnvironmentScope: old.module.piEnvironmentScope, residentFacts: () => facts,
    load: vi.fn(async () => ({ ok: true as const, value: next })),
    bindFutureOpen: vi.fn(() => ({ ok: true as const, value: { rollback: vi.fn() } })) };
  const installed = installRunnerFactoryBootstrap(options);
  expect(installed.ok).toBe(true); if (!installed.ok) throw new Error(installed.error.message);
  expect(server.listeners("connection")).toContain(predecessorListener);
  expect(server.listenerCount("connection")).toBe(2);
  expect(options.bindFutureOpen).toHaveBeenCalledWith(installed.value);
  expect(installRunnerFactoryBootstrap(options)).toMatchObject({ ok: false, error: { code: "factory-conflict" } });
  const current = await peer(path);
  try {
    before.socket.write('{"type":"status"}\n');
    expect(await before.read()).not.toHaveProperty("factoryProtocol");
    current.socket.write('{"type":"status"}\n');
    expect(await current.read()).toMatchObject({ factoryProtocol: RUNNER_FACTORY_PROTOCOL, futureFactory: old.identity, residentFactories: facts, sessions: 1, activeSessions: 1 });
    const request = JSON.stringify({ type: "upgrade_factory", protocol: RUNNER_FACTORY_PROTOCOL, owner: options.owner, expected: old.identity, candidate: next.identity }) + "\n";
    current.socket.write(request.slice(0, 9));
    current.socket.write(request.slice(9, 47));
    current.socket.write(request.slice(47) + '{"type":"status"}\n{"type":"retain"}\n');
    const replies = [await current.read(), await current.read(), await current.read()];
    expect(replies.find(value => value.protocol === RUNNER_FACTORY_PROTOCOL)).toMatchObject({ ok: true, previous: old.identity, current: next.identity, residentFactories: facts });
    expect(replies.find(value => value.original === "retain")).toMatchObject({ ok: true });
    expect(forwarded).toEqual(["status", "status", "status", "retain"]);
    expect(installed.value.futureFactory.snapshot()).toBe(next);
    expect(facade.sdk).toBe(originalFacade);
    expect(resident).toMatchObject({ active: true, pending: 2 });
    expect(resident.close).not.toHaveBeenCalled(); expect(resident.command).not.toHaveBeenCalled();
    current.socket.write('{"type":"status"}\n');
    expect(await current.read()).toMatchObject({ futureFactory: next.identity, residentFactories: facts });
    current.socket.write('{"type":"upgrade_factory","candidate":null}\n');
    expect(await current.read()).toMatchObject({ ok: false, errorCode: "factory-contract-invalid" });
    owned = false;
    current.socket.write(JSON.stringify({ type: "upgrade_factory", protocol: RUNNER_FACTORY_PROTOCOL, owner: options.owner, expected: next.identity, candidate: old.identity }) + "\n");
    expect(await current.read()).toMatchObject({ ok: false, errorCode: "ownership-conflict" });
    expect(installed.value.futureFactory.snapshot()).toBe(next);
  } finally {
    before.socket.destroy(); current.socket.destroy(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true });
  }
});

test("lease loss after future-open preparation restores the predecessor and never installs capability", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-bootstrap-rollback-")), path = join(root, "native.sock");
  const original = () => {}, server = createServer(original);
  await new Promise<void>(resolve => server.listen(path, resolve));
  let owned = true;
  const rollback = vi.fn();
  try {
    const result = installRunnerFactoryBootstrap({ server,
      owner: { version: 1, dataDir: root, uid: process.getuid!(), control: path, pid: process.pid, startTicks: "42" },
      leaseEvidence: { bridgePid: 99 }, assertLease: () => { if (!owned) throw new Error("bridge disappeared"); },
      serial: action => action(), initial: binding("a"), initialEnvironmentScope: new AsyncLocalStorage(), residentFacts: () => [],
      load: async () => ({ ok: true, value: binding("b") }),
      bindFutureOpen: () => { owned = false; return { ok: true, value: { rollback } }; },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "ownership-conflict" } });
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(server.listeners("connection")).toEqual([original]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
