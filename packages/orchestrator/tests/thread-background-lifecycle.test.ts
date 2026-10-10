import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiCommand, PiEvent, PiSession, PiSessionOptions } from "../src/threads/contracts.js";
import { ThreadService } from "../src/threads/service.js";

class Native implements PiSession {
  active = false;
  accepted = new Set<string>();
  completed = new Set<string>();
  constructor(readonly options: PiSessionOptions, private output: (event: PiEvent) => void) {
    writeFileSync(options.sessionFile, JSON.stringify({ type: "session", id: options.threadId }) + "\n");
  }
  async command(command: PiCommand) {
    if (command.type === "prompt" || command.type === "steer") {
      this.accepted.add(String(command.workId)); this.active = true;
      this.output({ type: "agent_start" });
    }
    if (command.type === "abort") this.active = false;
    this.output({ type: "response", id: command.id, command: command.type, success: true,
      data: command.type === "get_state" ? { isStreaming: this.active, pendingMessageCount: 0,
        acceptedWorkIds: [...this.accepted], completedWorkIds: [...this.completed], sessionFile: this.options.sessionFile } : {} });
  }
  settle(text: string) {
    for (const id of this.accepted) this.completed.add(id);
    this.active = false;
    const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now() };
    this.output({ type: "message_end", message }); this.output({ type: "agent_settled" });
  }
  async close() {}
}

const roots: string[] = [];
const services: ThreadService[] = [];
function fixture(root = mkdtempSync(join(tmpdir(), "background-lifecycle-"))) {
  if (!roots.includes(root)) roots.push(root);
  const sessions = new Map<string, Native>();
  const options = { capacity: { mode: "unmanaged" } as const, databasePath: join(root, "threads.sqlite"), sessionsDir: root,
    openSession: async (input: PiSessionOptions, output: (event: PiEvent) => void) => {
      const session = new Native(input, output); sessions.set(input.threadId, session); return session;
    } };
  const service = new ThreadService(options); services.push(service);
  return { root, service, sessions, options };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)); }
  throw new Error("Expected background lifecycle transition did not arrive");
}
afterEach(async () => {
  for (const service of services.splice(0).reverse()) await service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("archives completed background threads without consuming their transcript or unread result", async () => {
  const f = fixture();
  await f.service.start();
  const parent = await f.service.spawn({ id: "parent", requestId: "parent", cwd: f.root });
  if (!parent.ok) throw new Error(parent.error.message);
  const child = await f.service.spawn({ id: "background", requestId: "background", parentId: "parent", cwd: f.root, message: "finish" });
  if (!child.ok) throw new Error(child.error.message);
  await until(() => !!f.sessions.get("background")?.active);
  f.sessions.get("background")!.settle("Finished result");
  await until(() => f.service.get("background")?.metadata?.archived === true);

  expect(f.service.get("background")).toMatchObject({ state: "idle", held: false, metadata: { archived: true, foreground: false } });
  expect(f.service.pending("parent").some(message => message.text.includes("Finished result"))).toBe(true);
  expect(readFileSync(child.value.sessionFile, "utf8")).toContain('"background"');
  expect(f.service.latestSettlement("background")?.finalMessage).toMatchObject({ content: [{ text: "Finished result" }] });
});

it("leaves foreground threads in the live directory and archives settled watch checks, including incomplete ones", async () => {
  const f = fixture(); await f.service.start();
  for (const [id, text] of [["foreground", "foreground"], ["watch", "watch"], ["watch-blank", ""]] as const) {
    const result = await f.service.spawn({ id, requestId: id, cwd: f.root, message: "finish" });
    if (!result.ok) throw new Error(result.error.message);
    if (id === "foreground") {
      const placed = await f.service.control({ threadId: id, action: "placement", foreground: true });
      if (!placed.ok) throw new Error(placed.error.message);
    } else {
      const db = new DatabaseSync(join(f.root, "threads.sqlite"));
      db.prepare("UPDATE thread SET metadata=json_set(metadata,'$.watchList',json('true')) WHERE id=?").run(id);
      db.close();
    }
    await until(() => !!f.sessions.get(id)?.active);
    f.sessions.get(id)!.settle(text);
    if (id === "foreground") {
      await until(() => f.service.get(id)?.state === "idle");
      expect(f.service.get(id)?.metadata?.archived).not.toBe(true);
    } else await until(() => f.service.get(id)?.metadata?.archived === true);
  }
  expect(f.service.latestSettlement("watch-blank")).toMatchObject({ outcome: "failed", error: expect.stringContaining("without a final result") });
  expect(f.service.watchCheckOutcome("watch-blank")).toMatchObject({ ok: true, value: { status: "failed" } });
  expect(f.service.watchCheckOutcome("watch")).toMatchObject({ ok: true, value: { status: "complete" } });
});

it("backfills previously completed background work on restart", async () => {
  const first = fixture(); await first.service.start();
  const parent = await first.service.spawn({ id: "parent", requestId: "parent", cwd: first.root });
  if (!parent.ok) throw new Error(parent.error.message);
  const thread = await first.service.spawn({ id: "old-background", requestId: "old", parentId: "parent", cwd: first.root, message: "finish" });
  if (!thread.ok) throw new Error(thread.error.message);
  await until(() => !!first.sessions.get("old-background")?.active);
  first.sessions.get("old-background")!.settle("Persisted result");
  await until(() => first.service.get("old-background")?.state === "idle");

  const db = new DatabaseSync(join(first.root, "threads.sqlite"));
  db.prepare("UPDATE thread SET metadata=json_remove(metadata,'$.archived','$.archivedAt','$.runnerReference') WHERE id=?").run("old-background");
  db.close();
  await first.service.close();
  const next = fixture(first.root); await next.service.start();
  await until(() => next.service.get("old-background")?.metadata?.archived === true);
  expect(next.service.latestSettlement("old-background")?.finalMessage).toMatchObject({ content: [{ text: "Persisted result" }] });
  expect(readFileSync(thread.value.sessionFile, "utf8")).toContain('"old-background"');
});
