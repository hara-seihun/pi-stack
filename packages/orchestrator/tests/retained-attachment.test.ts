import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadService } from "../src/threads/service.js";
import type { PiCommand, PiEvent, PiSession, Result } from "../src/threads/contracts.js";

const roots: string[] = [], services: ThreadService[] = [];
const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };
afterEach(async () => {
  for (const service of services.splice(0)) await service.detach();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(busy: boolean, pendingAttachment = false) {
  const root = mkdtempSync(join(tmpdir(), "retained-attachment-")); roots.push(root);
  let output!: (event: PiEvent) => void, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const commands: PiCommand[] = [];
  const session: PiSession = {
    async command(command) {
      commands.push(command);
      output({ type: "response", id: command.id, command: command.type, success: true,
        data: command.type === "get_state" ? { isStreaming: busy, pendingMessageCount: 0 } : {} });
    },
    async close() {},
  };
  const attachSession = vi.fn(async (_reference, receive: (event: PiEvent) => void) => {
    output = receive;
    if (pendingAttachment) await gate;
    return session;
  });
  const openSession = vi.fn(async (_options, receive: (event: PiEvent) => void) => { output = receive; return session; });
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(root, "threads.sqlite3"), sessionsDir: root, openSession, attachSession });
  services.push(service);
  const thread = unwrap(await service.spawn({ requestId: "thread", cwd: root }));
  const owner = service as any;
  owner.sql("UPDATE thread SET metadata=json_set(metadata,'$.runnerReference',json(?)) WHERE id=?")
    .run(JSON.stringify({ control: join(root, "control.sock"), socketPath: join(root, "session.sock") }), thread.id);
  return { service, owner, thread, attachSession, openSession, session, release, commands };
}

it("coalesces repeated and concurrent custody attachment without replacing the native client", async () => {
  const f = await fixture(false, true);
  const first = f.owner.attach(f.thread.id), second = f.owner.attach(f.thread.id);
  const opened = f.owner.open(f.thread.id, f.thread.settings, false);
  expect(f.attachSession).toHaveBeenCalledTimes(1);
  f.release();
  const runtime = await first;
  expect(await second).toBe(runtime);
  expect(await opened).toBe(runtime);
  expect(await f.owner.attach(f.thread.id)).toBe(runtime);
  expect(f.attachSession).toHaveBeenCalledTimes(1);
  expect(f.openSession).not.toHaveBeenCalled();
  expect(f.commands.map(command => command.type)).toEqual(["get_state"]);
  expect(runtime.busy).toBe(false);
});

it("restores real active custody without submitting or cancelling input", async () => {
  const f = await fixture(true);
  const runtime = await f.owner.attach(f.thread.id);
  expect(runtime.busy).toBe(true);
  expect(f.commands.map(command => command.type)).toEqual(["get_state"]);
  expect(f.service.get(f.thread.id)?.metadata?.runnerReference).toBeDefined();
});

it("an attached idle session can receive its original queued message after owner restoration", async () => {
  const f = await fixture(false);
  await f.owner.attach(f.thread.id);
  unwrap(await f.service.send({ requestId: "pending", threadId: f.thread.id, text: "continue", delivery: "steer" }));
  unwrap(await f.service.start());
  for (let i = 0; i < 100 && !f.service.pending(f.thread.id)[0]?.landedAt; i++) await new Promise<void>(resolve => setImmediate(resolve));
  const pending = f.service.pending(f.thread.id)[0]!;
  expect(pending.id).toBe("pending");
  expect(pending.landedAt).toEqual(expect.any(Number));
  expect(f.commands.filter(command => command.type === "prompt").map(command => command.workId)).toEqual(["pending"]);
  expect(f.commands.some(command => command.type === "abort")).toBe(false);
});
