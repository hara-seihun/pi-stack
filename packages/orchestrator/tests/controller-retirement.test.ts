import { createServer } from "node:http";
import { createServer as createSocketServer, createConnection } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { retireController } from "../src/controller-retirement.js";
import { Daemon } from "../src/daemon.js";
import { createSharedPiSessionOpener } from "../src/threads/runner-transport.js";

it("retires stalled control waits in one concurrent budget, reporting the exact edge without cancelling effects", async () => {
  const execution = new AbortController();
  const events: unknown[] = [];
  const outcome = await retireController([
    { edge: "native-ownership", close: async () => {} },
    { edge: "opening", close: () => new Promise(() => {}) },
    { edge: "error", close: async () => { throw new Error("control closed"); } },
  ], 20, event => events.push(event));
  expect(outcome).toMatchObject({ state: "retained", edges: [
    { edge: "native-ownership", state: "closed" }, { edge: "opening", state: "retained" },
    { edge: "error", state: "error", error: "Error: control closed" },
  ] });
  expect(events).toHaveLength(6);
  expect(execution.signal.aborted).toBe(false);
});

it("suspends every admission owner before draining, closes an unfinished HTTP body, and detaches completions", async () => {
  const order: string[] = [];
  const controller = Object.create(Daemon.prototype) as any;
  const service = (name: string) => ({
    suspend: () => order.push(`${name}:suspend`),
    detach: async () => { expect(order).toContain(`${name}:suspend`); order.push(`${name}:detach`); return { ok: true, value: undefined }; },
  });
  const observation = new AbortController();
  Object.assign(controller, {
    threads: service("threads"), isolated: new Map([["fixture", service("application")]]),
    schedules: { suspend: () => order.push("schedules:suspend"), close: async () => {} },
    fleet: { detach: () => order.push("fleet:detach") }, observation,
    opener: { detach: () => order.push("native:detach") },
    completionPool: { detach: vi.fn(async () => {}), close: vi.fn() },
    waitForReconcile: async () => { expect(observation.signal.aborted).toBe(true); },
  });
  const server = createServer(() => {});
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const client = createConnection(address.port, "127.0.0.1");
  client.on("error", () => {});
  await new Promise<void>(resolve => client.once("connect", resolve));
  client.write("POST /v1/threads/send HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\n{");
  const logs = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const outcome = await controller.retire(server);
    expect(outcome.state).toBe("closed");
    expect(controller.completionPool.detach).toHaveBeenCalledOnce();
    expect(controller.completionPool.close).not.toHaveBeenCalled();
    expect(order.slice(0, 5)).toEqual(["threads:suspend", "application:suspend", "schedules:suspend", "fleet:detach", "native:detach"]);
    expect(server.listening).toBe(false);
    expect(logs.mock.calls.some(([line]) => JSON.parse(String(line)).type === "fleet-controller-retired")).toBe(true);
  } finally { logs.mockRestore(); client.destroy(); server.closeAllConnections(); server.close(); }
});

it("detaches an unacknowledged native control observation without sending close/abort or reopening it", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-retirement-"));
  const control = join(root, "thread-runners", "fixture.sock");
  const socketPath = join(root, "thread-sockets", "fixture.sock");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(root, "thread-runners")); mkdirSync(join(root, "thread-sockets"));
  const received: unknown[] = [];
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const sockets = new Set<import("node:net").Socket>();
  const server = createSocketServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.on("data", data => { received.push(JSON.parse(data.toString())); entered(); });
  });
  await new Promise<void>(resolve => server.listen(control, resolve));
  const opener = createSharedPiSessionOpener({ dataDir: root });
  try {
    const pending = opener.attachSession({ control, socketPath }, () => {}, () => {});
    await ready;
    opener.detach();
    await expect(pending).rejects.toThrow("native command custody is unchanged");
    expect(received).toEqual([{ type: "status" }]);
  } finally {
    opener.detach(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
