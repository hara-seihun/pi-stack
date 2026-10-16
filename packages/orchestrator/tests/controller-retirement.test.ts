import { createServer as createSocketServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { retireController } from "../src/controller-retirement.js";
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
