import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadService } from "../src/threads/service.js";
import { ThreadDirectory } from "../src/threads/directory.js";
import { createThreadClient, threadHttp } from "../src/threads/http.js";
import { threadTools } from "../src/threads/pi-tools.js";
import { callerResolver } from "../src/threads/caller.js";
import { RunnerStartupError } from "../src/threads/runner-startup.js";
import { WatchList, watchInterval, watchSettings, type WatchItem } from "../src/threads/watch-list.js";
import type { Result, PiSessionOptions, OpenPiSession, PiEvent, PiCommand } from "../src/threads/contracts.js";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function value<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.message); return result.value; }
function fixture(openSession?: OpenPiSession, intervalMs?: number) {
  const root = mkdtempSync(join(tmpdir(), "watch-list-"));
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
  const opened: PiSessionOptions[] = [];
  const owner = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(root, "threads.sqlite"), sessionsDir: join(root, "sessions"), openSession: async (options, output, exit) => { opened.push(options); if (openSession) return openSession(options, output, exit); throw Error("no model calls in this fixture"); } });
  cleanups.push(() => owner.close());
  const options = { databasePath: join(root, "threads.sqlite"), threads: owner,
    placement: () => ({ ok: true as const, value: { cwd: root, metadata: { profileId: "home" } } }), intervalMs, onError: vi.fn(), checkOutcome: (id: string) => owner.watchCheckOutcome(id) };
  const watch = new WatchList(options); owner.setWatchList(watch);
  cleanups.push(() => watch.close());
  const add = async (what = "Check a fixture", nextDueAt = 100) => value(await watch.watch({ threadId: "agent", action: "add", requestId: `add:${what}`, item: { what, why: "Fixture state matters", nextDueAt } })) as { item: WatchItem };
  return { root, owner, watch, options, opened, add };
}
it("persists per-person items and replay-safe add/update/remove receipts across restart", async () => {
  const { watch, options, owner, add } = fixture();
  const { item } = await add();
  expect(item).toMatchObject({ addedBy: "agent", what: "Check a fixture", createdAt: expect.any(Number) });
  const update = { action: "update" as const, threadId: "another-agent", requestId: "update", id: item.id, patch: { how: "Read fixture", cadenceMs: 120_000 } };
  expect(await watch.watch(update)).toEqual(await watch.watch(update));
  expect(await watch.watch({ ...update, patch: { what: "different" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
  await watch.close(); cleanups.pop();
  const restored = new WatchList(options); owner.setWatchList(restored); cleanups.push(() => restored.close());
  expect(value(await restored.watch({ action: "list", threadId: "agent" }))).toMatchObject({ items: [{ id: item.id, how: "Read fixture", cadenceMs: 120_000 }] });
  expect(await restored.watch({ ...update, requestId: "clear", patch: { how: null, cadenceMs: null } })).toMatchObject({ ok: true, value: { item: expect.not.objectContaining({ how: expect.anything(), cadenceMs: expect.anything() }) } });
  const remove = { action: "remove" as const, threadId: "agent", requestId: "remove", id: item.id };
  expect(await restored.watch(remove)).toEqual(await restored.watch(remove));
  expect(value(await restored.watch({ action: "list", threadId: "agent" }))).toEqual({ items: [] });
});
it("makes no calls when empty or not due, and creates exactly one visible Opus 5.5 thread for due work", async () => {
  const { watch, owner, add, opened } = fixture();
  const spawn = vi.spyOn(owner, "spawn"); const list = vi.spyOn(owner, "list");
  value(await watch.tick(100)); expect(spawn).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
  const { item } = await add("A future check", 200);
  value(await watch.tick(199)); expect(spawn).not.toHaveBeenCalled();
  await Promise.all([watch.tick(200), watch.tick(200)]);
  expect(spawn).toHaveBeenCalledTimes(1);
  const thread = value(await owner.list()).threads[0]!;
  expect(thread).toMatchObject({ parentId: null, role: "agent", title: "Watch list check", metadata: { watchList: true }, settings: { model: "anthropic/claude-opus-5-5", thinkingLevel: "high", speed: "standard" } });
  expect(owner.pending(thread.id)[0]?.text).toContain("request_user_input_async");
  expect(owner.pending(thread.id)[0]?.text).toContain("A future check");
  expect(owner.pending(thread.id)[0]?.text).toContain("Always end the turn with a short final text reply");
  expect(value(await watch.watch({ action: "list", threadId: "agent" }))).toMatchObject({ items: [{ id: item.id, lastCheck: { threadId: thread.id, status: "scheduled" }, nextDueAt: 200 + 45 * 60_000 }] });
  value(await watch.tick(1e8)); expect(spawn).toHaveBeenCalledTimes(1);
  expect(opened).toHaveLength(0);
  expect(await owner.spawn({ requestId: "recursive", parentId: thread.id, cwd: thread.cwd, message: "delegate" })).toMatchObject({ ok: true, value: { role: "agent", parentId: thread.id } });
});
it("dispatches a real ordinary thread with the pinned model and watch tools, then settles without another wake", async () => {
  let emit: (event: PiEvent) => void = () => {};
  const commands: PiCommand[] = [];
  const { watch, owner, opened, add } = fixture(async (_options, output) => {
    emit = output;
    return { close: async () => {}, command: async command => {
      commands.push(command);
      output({ type: "response", command: command.type, id: command.id, success: true, data: { isStreaming: false, pendingMessageCount: 0 } });
    } };
  });
  await owner.start(); await add(); value(await watch.tick(100));
  for (let i = 0; i < 50 && !commands.some(command => command.type === "prompt"); i++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(commands.find(command => command.type === "prompt")?.message).toContain("Check a fixture");
  expect(opened[0]?.args).toEqual(expect.arrayContaining(["anthropic", "claude-opus-5-5", "high"]));
  expect(opened[0]?.env.PI_THREAD_CAN_SPAWN).toBe("1");
  expect(threadTools(opened[0]!).map(tool => tool.name)).toContain("watch_list_update");
  expect(threadTools(opened[0]!).map(tool => tool.name)).toContain("thread_spawn");
  const finalMessage = { role: "assistant", content: [{ type: "text", text: "Fixture checked." }], stopReason: "stop" };
  emit({ type: "agent_settled", lastAssistantMessage: finalMessage });
  for (let i = 0; i < 50 && !value(await owner.list()).threads.every(thread => thread.state === "idle"); i++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(value(await owner.list()).threads[0]?.state).toBe("idle");
  value(await watch.tick(101)); expect(opened).toHaveLength(1);
});
it("keeps a check with an unanswered decision open, keeps checking its items, and tells the next check not to repeat the question", async () => {
  const { watch, owner, add } = fixture();
  await add(); value(await watch.tick(100));
  const first = value(await owner.list()).threads[0]!;
  value(await owner.control({ threadId: first.id, action: "cancel" }));
  const asked = value(await owner.ask({ threadId: first.id, requestId: "decision", questions: [{ question: "Commit to this?" }] }));
  value(await watch.tick(1e8));
  const second = value(await owner.list()).threads.find(thread => thread.id !== first.id)!;
  expect(owner.pending(second.id)[0]?.text).toContain('"what": "Check a fixture"');
  expect(owner.pending(second.id)[0]?.text).toContain("Commit to this?");
  expect(owner.get(first.id)?.metadata?.archived).toBeUndefined();
  value(await owner.control({ threadId: second.id, action: "cancel" }));
  value(await owner.answer({ threadId: first.id, questionId: asked.questionIds[0]!, selectedSuggestionIds: [], text: "No commitment" }));
  expect(owner.pending(first.id)[0]?.text).toContain("No commitment");
});
function settlingFixture(finalText: string) {
  let emit: (event: PiEvent) => void = () => {};
  const prompted: string[] = [];
  const built = fixture(async (_options, output) => {
    emit = output;
    return { close: async () => {}, command: async command => {
      if (command.type === "prompt") prompted.push(command.message as string);
      output({ type: "response", command: command.type, id: command.id, success: true, data: { isStreaming: false, pendingMessageCount: 0 } });
    } };
  }, 60_000);
  const settle = async () => {
    for (let i = 0; i < 100 && !prompted.length; i++) await new Promise<void>(resolve => setImmediate(resolve));
    prompted.length = 0;
    emit({ type: "agent_settled", lastAssistantMessage: { role: "assistant", content: finalText ? [{ type: "text", text: finalText }] : [], stopReason: "stop" } });
  };
  return { ...built, settle };
}
async function settled(owner: ThreadService, id: string) {
  for (let i = 0; i < 200 && !(owner.latestSettlement(id) && owner.get(id)?.state === "idle"); i++) await new Promise<void>(resolve => setImmediate(resolve));
  for (let i = 0; i < 50; i++) await new Promise<void>(resolve => setImmediate(resolve));
}
it("archives a completed check like any background worker and records it as a complete check on its items", async () => {
  const { watch, owner, add, settle } = settlingFixture("Checked; nothing changed.");
  await owner.start(); const { item } = await add(); value(await watch.tick(100));
  const first = value(await owner.list()).threads[0]!;
  await settle(); await settled(owner, first.id);
  expect(owner.get(first.id)?.metadata?.archived).toBe(true);
  value(await watch.tick(100 + 60_000));
  const items = (value(await watch.watch({ action: "list", threadId: "agent" })) as { items: WatchItem[] }).items;
  const next = items[0]!.lastCheck!;
  expect(next).toMatchObject({ status: "scheduled" });
  expect(next.threadId).not.toBe(first.id);
  expect(value(await owner.list({ id: next.threadId, limit: 1 })).threads).toHaveLength(1);
  expect(items[0]!.id).toBe(item.id);
});
it("records a check that ends without a final result as a failed check, disposes of it, and checks the item again when due", async () => {
  const { watch, owner, add, settle } = settlingFixture("");
  await owner.start(); const { item } = await add(); value(await watch.tick(100));
  const first = value(await owner.list()).threads[0]!;
  await settle(); await settled(owner, first.id);
  expect(owner.latestSettlement(first.id)).toMatchObject({ outcome: "failed", error: expect.stringContaining("without a final result") });
  expect(owner.get(first.id)?.metadata?.archived).toBe(true);
  value(await watch.tick(101));
  expect(value(await watch.watch({ action: "list", threadId: "agent" }))).toMatchObject({ items: [{ id: item.id, lastCheck: { threadId: first.id, status: "failed", error: expect.stringContaining("without a final result") } }] });
  value(await watch.tick(100 + 60_000));
  const items = (value(await watch.watch({ action: "list", threadId: "agent" })) as { items: WatchItem[] }).items;
  expect(items[0]!.lastCheck).toMatchObject({ status: "scheduled" });
  expect(items[0]!.lastCheck!.threadId).not.toBe(first.id);
});
it("migrates items that name only their last worker and reconciles that worker's outcome", async () => {
  const { watch, owner, options, add } = fixture();
  const { item } = await add(); value(await watch.tick(100));
  const first = value(await owner.list()).threads[0]!;
  value(await owner.control({ threadId: first.id, action: "update", archived: true }));
  await watch.close(); cleanups.pop();
  const db = new DatabaseSync(options.databasePath);
  const { lastCheck: _check, ...body } = JSON.parse((db.prepare("SELECT body FROM watch_item WHERE id=?").get(item.id) as { body: string }).body) as WatchItem;
  db.prepare("UPDATE watch_item SET body=? WHERE id=?").run(JSON.stringify({ ...body, lastThreadId: first.id }), item.id); db.close();
  const restored = new WatchList(options); cleanups.push(() => restored.close());
  expect(value(await restored.watch({ action: "list", threadId: "agent" }))).toEqual({ items: [expect.not.objectContaining({ lastThreadId: expect.anything() })] });
  value(await restored.tick(101));
  expect(value(await restored.watch({ action: "list", threadId: "agent" }))).toMatchObject({ items: [{ lastCheck: { threadId: first.id, status: "failed", error: expect.any(String) } }] });
  value(await restored.tick(100 + 45 * 60_000));
  expect(value(await owner.list()).threads).toHaveLength(2);
});
it("enforces the person's wake interval across short cadences, new items, retiming, and restart", async () => {
  const interval = 4 * 60 * 60_000;
  const { watch, owner, options, add } = fixture(undefined, interval);
  const { item } = await add();
  value(await watch.watch({ action: "update", threadId: "agent", requestId: "short", id: item.id, patch: { cadenceMs: 180_000 } }));
  const { item: slower } = await add("Daily check");
  value(await watch.watch({ action: "update", threadId: "agent", requestId: "slow", id: slower.id, patch: { cadenceMs: 86_400_000 } }));
  value(await watch.tick(100));
  const first = value(await owner.list()).threads[0]!;
  value(await owner.control({ threadId: first.id, action: "stop", descendants: false }));
  expect(value(await watch.watch({ action: "list", threadId: "agent" }))).toMatchObject({ items: [{ id: item.id, nextDueAt: 100 + interval }, { id: slower.id, nextDueAt: 100 + 86_400_000 }] });
  value(await watch.watch({ action: "update", threadId: "agent", requestId: "retime", id: item.id, patch: { nextDueAt: 101 } }));
  await add("New due check", 101);
  value(await watch.tick(101));
  expect(value(await owner.list()).threads).toHaveLength(1);
  await watch.close(); cleanups.pop();
  const restored = new WatchList(options); cleanups.push(() => restored.close());
  value(await restored.tick(100 + interval - 1));
  expect(value(await owner.list()).threads).toHaveLength(1);
  value(await restored.tick(100 + interval));
  expect(value(await owner.list()).threads).toHaveLength(2);
});
it("reconciles a lost spawn acknowledgement after a scheduler restart without another thread", async () => {
  const { watch, owner, options, add } = fixture(undefined, 4 * 60 * 60_000);
  await add();
  const actual = owner.spawn.bind(owner);
  const spawn = vi.spyOn(owner, "spawn").mockImplementationOnce(async input => { value(await actual(input)); return { ok: false, error: { code: "unavailable", message: "lost acknowledgement" } }; });
  expect(await watch.tick(100)).toMatchObject({ ok: false });
  await watch.close(); cleanups.pop();
  const restored = new WatchList(options); cleanups.push(() => restored.close());
  value(await restored.tick(100));
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(spawn.mock.calls[1]?.[0]).toEqual(spawn.mock.calls[0]?.[0]);
  expect(value(await owner.list()).threads).toHaveLength(1);
});
it("routes fleet and native tools to the person's encrypted owner, with retry-safe HTTP mutations", async () => {
  const { owner, watch, root } = fixture();
  const directory = new ThreadDirectory({ id: "fleet", api: owner }, [{ id: "person", api: owner }]);
  let dropped = false;
  const client = createThreadClient("http://localhost/v1/threads", async (url, init) => {
    const response = (await threadHttp(directory, new Request(String(url), init)))!;
    if (!dropped) { dropped = true; throw Error("lost watch acknowledgement"); }
    return response;
  });
  const tools = threadTools({ threadId: "agent", cwd: root, sessionFile: "fixture", env: {}, args: [], threads: client });
  const tool = tools.find(tool => tool.name === "watch_list_add")!;
  const response = await tool.execute("add-tool", { what: "Check fixture", why: "For a test" }, new AbortController().signal, () => {}, {} as never);
  expect(response.details).toMatchObject({ ok: true });
  expect(value(await watch.watch({ action: "list", threadId: "agent" }))).toMatchObject({ items: [{ what: "Check fixture", addedBy: "agent" }] });
  expect(tools.filter(tool => tool.name.startsWith("watch_list"))).toHaveLength(4);
  expect(await new ThreadDirectory({ id: "fleet", api: owner }).watch({ action: "list", threadId: "agent" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
});
it("validates timing and caller provenance, and supports disabling checks without deleting items", async () => {
  const { watch, options, add } = fixture();
  for (const item of [{ what: " ", why: "why" }, { what: "what", why: "why", cadenceMs: -1 }, { what: "what", why: "why", nextDueAt: NaN }]) {
    expect(await watch.watch({ action: "add", threadId: "agent", requestId: "invalid", item })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  }
  expect(watchInterval(undefined)).toBe(45 * 60_000); expect(() => watchInterval("0")).toThrow();
  await add();
  const disabled = new WatchList({ ...options, enabled: false }); cleanups.push(() => disabled.close());
  value(await disabled.tick(1e8)); expect(value(await options.threads.list()).threads).toHaveLength(0);
  const resolver = callerResolver({ capability: { issue: () => "token", verify: () => "agent" } });
  expect(await resolver.admit("watch", { threadId: "someone-else" }, { kind: "thread", threadId: "agent" })).toMatchObject({ ok: false, status: 403 });
  expect(await resolver.admit("watch", { threadId: "agent" }, { kind: "process", uid: 1000 })).toMatchObject({ ok: false, status: 403 });
  expect(await resolver.admit("watch", { threadId: "agent" }, { kind: "thread", threadId: "agent" })).toMatchObject({ ok: true });
});

function routedFixture(origins: Record<string, string>, root = mkdtempSync(join(tmpdir(), "watch-routes-"))) {
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
  const owner = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(root, "threads.sqlite"), sessionsDir: join(root, "sessions"), openSession: async () => { throw Error("no model calls in this fixture"); } });
  cleanups.push(() => owner.close());
  const options = { databasePath: join(root, "threads.sqlite"), threads: owner, intervalMs: 4 * 60 * 60_000, onError: vi.fn(),
    checkOutcome: (id: string) => owner.watchCheckOutcome(id),
    destinations: ["personal", "home"], defaultDestination: "home",
    // As the Remote supervisor does: a thread's own profile, including watch checks spawned into one.
    destinationOf: (threadId: string) => origins[threadId] ?? owner.get(threadId)?.metadata?.profileId as string | undefined,
    placement: (destination: string) => destination === "personal"
      ? { ok: true as const, value: { cwd: join(root, "private"), metadata: { profileId: "personal", workspaceId: "private", contextFiles: ["HARA.md", "KENAN.md"] } } }
      : { ok: true as const, value: { cwd: root, metadata: { profileId: destination, workspaceId: "home" } } } };
  const watch = new WatchList(options); owner.setWatchList(watch);
  cleanups.push(() => watch.close());
  const add = async (threadId: string, what: string, extra: Record<string, unknown> = {}) =>
    (value(await watch.watch({ threadId, action: "add", requestId: `add:${what}`, item: { what, why: "It matters", nextDueAt: 100, ...extra } })) as { item: WatchItem }).item;
  return { root, owner, watch, options, add };
}
it("places each item in its adding thread's destination and checks each destination in its own thread and context", async () => {
  const { owner, watch, add } = routedFixture({ "personal-thread": "personal", "home-thread": "home", "sandbox-thread": "sandbox" });
  const meds = await add("personal-thread", "Medication continuity");
  const job = await add("home-thread", "Converge job terminal");
  const fleet = await add("fleet-thread", "Fleet-forwarded check");
  const sandboxed = await add("sandbox-thread", "Sandboxed caller");
  const moved = await add("home-thread", "Permit reply", { destination: "personal" });
  expect([meds, job, fleet, sandboxed, moved].map(item => item.destination)).toEqual(["personal", "home", undefined, undefined, "personal"]);
  expect(await watch.watch({ threadId: "home-thread", action: "add", requestId: "bad", item: { what: "x", why: "y", destination: "raw" } })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  value(await watch.tick(100));
  const threads = value(await owner.list()).threads;
  expect(threads).toHaveLength(2);
  const personal = threads.find(thread => thread.metadata?.profileId === "personal")!;
  const home = threads.find(thread => thread.metadata?.profileId === "home")!;
  expect(personal).toMatchObject({ title: "Watch list check", cwd: expect.stringContaining("private"), metadata: { watchList: true, workspaceId: "private", contextFiles: ["HARA.md", "KENAN.md"] } });
  expect(home.metadata).not.toHaveProperty("contextFiles");
  const personalPrompt = owner.pending(personal.id)[0]!.text, homePrompt = owner.pending(home.id)[0]!.text;
  expect(personalPrompt).toContain("Medication continuity"); expect(personalPrompt).toContain("Permit reply"); expect(personalPrompt).toContain("personal destination");
  expect(personalPrompt).not.toContain("Converge job terminal"); expect(personalPrompt).not.toContain("Fleet-forwarded check");
  for (const what of ["Converge job terminal", "Fleet-forwarded check", "Sandboxed caller"]) expect(homePrompt).toContain(what);
  expect(homePrompt).not.toContain("Medication continuity");
  const items = (value(await watch.watch({ action: "list", threadId: "x" })) as { items: WatchItem[] }).items;
  expect(Object.fromEntries(items.map(item => [item.what, item.lastCheck?.threadId]))).toEqual({
    "Medication continuity": personal.id, "Permit reply": personal.id, "Converge job terminal": home.id, "Fleet-forwarded check": home.id, "Sandboxed caller": home.id });
  // A check thread adds into the destination it runs in, and an update can move an item.
  expect((await add(personal.id, "Follow-up from the personal check")).destination).toBe("personal");
  expect((value(await watch.watch({ threadId: home.id, action: "update", requestId: "move", id: job.id, patch: { destination: "personal" } })) as { item: WatchItem }).item.destination).toBe("personal");
  expect((value(await watch.watch({ threadId: home.id, action: "update", requestId: "retime", id: meds.id, patch: { nextDueAt: 5 } })) as { item: WatchItem }).item.destination).toBe("personal");
  // The global floor holds across destinations: nothing new until the interval passes, even with every check stopped.
  // A stopped check is a failed check: its items are checked again when due, by a fresh check in their destination.
  for (const thread of threads) value(await owner.control({ threadId: thread.id, action: "stop", descendants: false }));
  value(await watch.tick(101)); expect(value(await owner.list()).threads).toHaveLength(2);
  value(await watch.tick(100 + 4 * 60 * 60_000));
  const next = value(await owner.list()).threads.filter(thread => !threads.some(prior => prior.id === thread.id));
  expect(next.map(thread => thread.metadata?.profileId).sort()).toEqual(["home", "personal"]);
  const nextPersonal = owner.pending(next.find(thread => thread.metadata?.profileId === "personal")!.id)[0]!.text;
  expect(nextPersonal).toContain("Follow-up from the personal check"); expect(nextPersonal).toContain("Medication continuity");
});
it("backfills pre-destination items from their adding thread and leaves unresolved origins on the default", async () => {
  const root = mkdtempSync(join(tmpdir(), "watch-backfill-"));
  const legacy = new WatchList({ databasePath: join(root, "threads.sqlite"), threads: {} as never, placement: () => ({ ok: false, error: { code: "unavailable", message: "unused" } }), onError: vi.fn(),
    checkOutcome: () => ({ ok: false, error: { code: "unavailable", message: "unused" } }) });
  const old = async (threadId: string, what: string) => (value(await legacy.watch({ threadId, action: "add", requestId: what, item: { what, why: "Before destinations", nextDueAt: 100 } })) as { item: WatchItem }).item;
  const personal = await old("personal-thread", "House exit"), engineering = await old("fleet-thread", "T4r job"), gone = await old("deleted", "Gone thread");
  expect([personal, engineering, gone].every(item => item.destination === undefined)).toBe(true);
  await legacy.close();
  const { owner, watch } = routedFixture({ "personal-thread": "personal", "deleted": "raw" }, root);
  expect(value(watch.backfill())).toBe(1);
  expect(value(watch.backfill())).toBe(0);
  const items = (value(await watch.watch({ action: "list", threadId: "x" })) as { items: WatchItem[] }).items;
  expect(items.map(item => [item.what, item.destination, item.updatedAt])).toEqual([["House exit", "personal", personal.updatedAt], ["T4r job", undefined, engineering.updatedAt], ["Gone thread", undefined, gone.updatedAt]]);
  value(await watch.tick(100));
  const threads = value(await owner.list()).threads;
  expect(threads.map(thread => thread.metadata?.profileId).sort()).toEqual(["home", "personal"]);
  expect(owner.pending(threads.find(thread => thread.metadata?.profileId === "home")!.id)[0]!.text).toContain("T4r job");
});
