import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadService } from "../src/threads/service.js";
import { ThreadDirectory } from "../src/threads/directory.js";
import { threadTools } from "../src/threads/pi-tools.js";
import { createThreadClient, threadHttp } from "../src/threads/http.js";
import { admissionFor, callerResolver, threadCapability } from "../src/threads/caller.js";
import { watchPrompt } from "../src/threads/watch-list.js";
import type { PiCommand, PiEvent, Result } from "../src/threads/contracts.js";

const roots: string[] = [], services: ThreadService[] = [];
const unwrap = <T>(value: Result<T>): T => { if (!value.ok) throw new Error(value.error.message); return value.value; };
const boundary = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) { for (let n = 0; n < 100; n++) { if (check()) return; await boundary(); } throw new Error("Expected lifecycle boundary did not arrive"); }
function fixture(root = mkdtempSync(join(tmpdir(), "thread-attention-")), workersOnly = false) {
  if (!roots.includes(root)) roots.push(root);
  const sessions: Array<{ emit(event: PiEvent): void }> = [];
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(root, "threads.sqlite"), sessionsDir: join(root, "sessions"), workersOnly,
    openSession: async (_options, output) => {
      const accepted = new Set<string>(); let running = false;
      const session = { emit(event: PiEvent) { if (event.type === "agent_settled") running = false; output(event); }, async command(command: PiCommand) {
        if (command.type === "prompt" || command.type === "steer") { running = true; accepted.add(String(command.workId)); output({ type: "agent_start" }); }
        if (command.type === "abort") running = false;
        output({ type: "response", id: command.id, command: command.type, success: true, data: command.type === "get_state" ? { isStreaming: running, pendingMessageCount: 0, acceptedWorkIds: [...accepted] } : {} });
      }, async close() {} };
      sessions.push(session); return session;
    },
  }); services.push(service); return { root, service, sessions };
}
afterEach(async () => { vi.restoreAllMocks(); for (const service of services.splice(0)) await service.detach(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const spawn = (f: ReturnType<typeof fixture>, id: string) => f.service.spawn({ id, requestId: `spawn:${id}`, cwd: f.root });

it("persists an explicit notice and foreground placement atomically, replays exact receipts and keeps scheduling/parentage", async () => {
  const f = fixture(); await spawn(f, "parent");
  unwrap(await f.service.spawn({ id: "worker", requestId: "spawn:worker", parentId: "parent", cwd: f.root, message: "Check", ephemeral: true }));
  unwrap(await f.service.wakeSchedule({ action: "set", threadId: "worker", requestId: "wake", reason: "Appointment", cadenceMs: 60000 }));
  const changes: string[] = []; f.service.subscribe(event => { if ("type" in event && event.type === "changed") changes.push(event.threadId); });
  const input = { threadId: "worker", requestId: "notice", summary: "Tour today at 2 pm Pacific. Bring ID.", foreground: true };
  const receipt = unwrap(await f.service.attention(input));
  expect(receipt).toMatchObject({ accepted: true, threadId: "worker", foreground: true, summary: input.summary });
  expect(changes).toEqual(["worker"]);
  expect(unwrap(await f.service.attention(input))).toEqual(receipt);
  expect(changes).toEqual(["worker"]);
  expect((await f.service.attention({ ...input, summary: "Changed" })).ok).toBe(false);
  expect(f.service.get("worker")).toMatchObject({ parentId: "parent", role: "worker", held: false, state: "running", metadata: { ephemeral: true, foreground: true, attentionSummary: input.summary }, wakeSchedule: { reason: "Appointment" } });
  expect(f.sessions).toHaveLength(0);
  expect(unwrap(f.service.attentionEvents()).items).toEqual([receipt]);
  expect(unwrap(f.service.attentionEvents(receipt.seq))).toEqual({ cursor: receipt.seq, items: [] });
  unwrap(await f.service.close());
  const restarted = fixture(f.root);
  expect(unwrap(restarted.service.attentionEvents()).items).toEqual([receipt]);
  expect(unwrap(await restarted.service.attention(input))).toEqual(receipt);
  expect(restarted.service.get("worker")?.metadata?.foreground).toBe(true);
});

it("notify-only does not promote; held, archived and invalid notices do not change attention custody", async () => {
  const f = fixture(); await spawn(f, "self");
  unwrap(await f.service.attention({ threadId: "self", requestId: "one", summary: "Your pickup moved to tomorrow." }));
  expect(f.service.get("self")?.metadata?.foreground).toBeUndefined();
  for (const summary of ["", "   ", "x".repeat(1001)]) expect((await f.service.attention({ threadId: "self", requestId: "bad", summary })).ok).toBe(false);
  expect((await f.service.attention({ threadId: "self", requestId: "bad", summary: "ok", foreground: "yes" } as never)).ok).toBe(false);
  expect((await f.service.attention({ threadId: "missing", requestId: "missing", summary: "ok" })).ok).toBe(false);
  unwrap(await f.service.control({ threadId: "self", action: "stop", descendants: false }));
  expect((await f.service.attention({ threadId: "self", requestId: "held", summary: "ok", foreground: true })).ok).toBe(false);
  unwrap(await f.service.control({ threadId: "self", action: "update", archived: true }));
  expect((await f.service.attention({ threadId: "self", requestId: "archived", summary: "ok" })).ok).toBe(false);
  expect(unwrap(f.service.attentionEvents()).items).toHaveLength(1);
  expect((await f.service.spawn({ id: "fake", requestId: "fake", cwd: f.root, metadata: { foreground: true } })).ok).toBe(false);
});

it("routes only authenticated self attention across authorized owners and tool calls retain stable request IDs", async () => {
  const person = fixture(), fleet = fixture(undefined, true); await spawn(person, "parent");
  const directory = new ThreadDirectory({ id: "person", api: person.service }, [{ id: "fleet", api: fleet.service }]);
  person.service.setDirectory(directory); fleet.service.setDirectory(directory);
  unwrap(await fleet.service.spawn({ id: "worker", requestId: "worker", cwd: fleet.root, parentId: "parent" }));
  const capability = threadCapability(join(person.root, "capability.key"));
  const resolver = callerResolver({ capability });
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(String(url), init);
    return (await threadHttp(directory, request, "/threads", admissionFor(resolver, { headers: request.headers })))!;
  };
  const client = createThreadClient("http://local/threads", fetcher, { token: capability.issue("worker") });
  expect((await client.attention({ threadId: "parent", requestId: "forged", summary: "Wrong sender" })).ok).toBe(false);
  expect((await createThreadClient("http://local/threads", fetcher).attention({ threadId: "worker", requestId: "process", summary: "Wrong sender" })).ok).toBe(false);
  const tools = threadTools({ threadId: "worker", cwd: fleet.root, sessionFile: "unused", args: [], env: { PI_THREAD_CAN_SPAWN: "0" }, threads: client });
  const tool = tools.find(tool => tool.name === "thread_attention")!;
  expect(tools.some(tool => tool.name === "thread_spawn")).toBe(false);
  const input = { summary: "Call the clinic before 4 pm Eastern.", foreground: true };
  const first = await tool.execute("call", input, new AbortController().signal, undefined, {} as never);
  expect(await tool.execute("call", input, new AbortController().signal, undefined, {} as never)).toEqual(first);
  expect(first.details).toMatchObject({ ok: true, value: { accepted: true, foreground: true } });
  expect(unwrap(fleet.service.attentionEvents()).items).toHaveLength(1);
  expect(unwrap(person.service.attentionEvents()).items).toHaveLength(0);
});

it.each([true, false])("an explicit-notice ephemeral worker still reports its result and remains reachable/leaf (foreground=%s)", async foreground => {
  const f = fixture(); await spawn(f, "parent"); unwrap(await f.service.start());
  unwrap(await f.service.spawn({ id: "child", requestId: "child", cwd: f.root, parentId: "parent", ephemeral: true, message: "Check" }));
  await until(() => f.sessions.length > 0);
  unwrap(await f.service.attention({ threadId: "child", requestId: "notice", summary: "Your appointment needs discussion.", foreground }));
  expect(f.service.get("child")?.state).toBe("running");
  f.sessions[0]!.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Checked" }], stopReason: "stop" } });
  f.sessions[0]!.emit({ type: "agent_settled" });
  await until(() => f.service.get("child")?.state === "idle");
  expect(f.service.get("child")?.metadata?.archived).not.toBe(true);
  expect(f.service.get("child")?.metadata?.foreground === true).toBe(foreground);
  expect(f.service.pending("parent")).toHaveLength(1);
  const now = Date.now() + 7200000; vi.spyOn(Date, "now").mockReturnValue(now);
  unwrap(await f.service.control({ threadId: "child", action: "archiveInactive", inactiveBefore: now - 3600000 }));
  expect(f.service.get("child")?.metadata?.archived).not.toBe(true);
  expect((await f.service.spawn({ id: "grandchild", requestId: "grandchild", parentId: "child", cwd: f.root })).ok).toBe(false);
});

it("scheduled check prompts and every normal attention tool carry action-based Renia reduction", () => {
  const prompt = watchPrompt([]);
  expect(prompt).toContain("Renia reduction"); expect(prompt).toContain("timezone");
  const tool = threadTools({ threadId: "self", cwd: "/tmp", sessionFile: "unused", args: [], env: {} }).find(tool => tool.name === "thread_attention")!;
  expect(tool.description).toContain("changes what they do"); expect(tool.description).toContain("unchanged notice");
});
