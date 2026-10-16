import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it, vi } from "vitest";
const records = vi.hoisted(() => new Map<string, any>());
vi.mock("../src/threads/runner-ownership.js", async original => ({
  ...await original<typeof import("../src/threads/runner-ownership.js")>(),
  nativeStorageOwner: (directory: string) => records.get(directory) ?? null,
  validateNativeRunnerDirectory: () => {},
}));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: () => { throw new Error("Must not launch a replacement"); } }));
import { createSharedPiSessionOpener } from "../src/threads/runner-transport.js";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); records.clear(); });
async function listen(path: string, receive: (value: any, socket: Socket) => void) {
  mkdirSync(dirname(path), { recursive: true });
  const clients = new Set<Socket>();
  const server = createServer(socket => { clients.add(socket); socket.on("error", () => {}); socket.on("close", () => clients.delete(socket)); createInterface({ input: socket }).on("line", line => receive(JSON.parse(line), socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  cleanup.push(async () => { for (const socket of clients) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
}
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "retained-native-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const control = join(dataDir, "thread-runners", `${"a".repeat(16)}.sock`);
  records.set(dataDir, { version: 1, dataDir, uid: process.getuid!(), pid: process.pid, control, startTicks: "fixture" });
  const opener = createSharedPiSessionOpener({ dataDir }); cleanup.push(() => opener.detach());
  return { dataDir, control, opener, options: { threadId: "fresh-thread", cwd: dataDir, sessionFile: join(dataDir, "fresh.jsonl"), args: [], env: { HOME: dataDir, PI_THREAD_API_URL: "http://127.0.0.1:1" } } };
}
it("fresh work uses the positive retained storage owner without draining or replacing it", async () => {
  const { control, opener, options } = fixture(); const observed: any[] = [];
  await listen(control, (value, socket) => {
    observed.push(value);
    if (value.type === "open") {
      void listen(value.options.socketPath, (_, peer) => peer.write('{"type":"attached"}\n')).then(() => socket.end(JSON.stringify({ ok: true, pid: process.pid }) + "\n"));
    } else socket.end(JSON.stringify({ ok: true, pid: process.pid, sessions: 1, activeSessions: 1, threadIds: ["other-active-thread"] }) + "\n");
  });
  const session = await opener.openSession(options, () => {}, () => {});
  expect(session).toBeDefined();
  expect(observed.filter(value => value.type === "open")).toHaveLength(1);
  expect(observed.find(value => value.type === "open").options.socketPath).toContain("a".repeat(16));
  expect(observed.some(value => ["close", "drain"].includes(value.type))).toBe(false);
});
it("unreachable retained ownership never launches a replacement", async () => {
  const { opener, options } = fixture();
  await expect(opener.openSession(options, () => {}, () => {})).rejects.toThrow();
});
