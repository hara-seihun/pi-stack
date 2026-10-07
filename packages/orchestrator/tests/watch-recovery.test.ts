import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadService } from "../src/threads/service.js";
import { RunnerStartupError } from "../src/threads/runner-startup.js";
import { WatchList, watchSettings, type WatchItem, type WatchListOptions } from "../src/threads/watch-list.js";
import type { Result } from "../src/threads/contracts.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function value<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.message); return result.value; }
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)); }
  throw new Error("Synthetic watch did not reach its expected custody state");
}
function fixture(nativeNotReady = true) {
  const root = mkdtempSync(join(tmpdir(), "watch-recovery-"));
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  let available = false;
  const owner = new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: root, openSession: async (_options, output) => {
    if (!available) throw nativeNotReady ? new RunnerStartupError("Model not found: synthetic SDK configuration error") : new Error("Model not found: unknown startup ownership");
    return { close: async () => {}, command: async command => output({ type: "response", id: command.id, command: command.type, success: true, data: { isStreaming: false, pendingMessageCount: 0 } }) };
  } });
  cleanup.push(() => owner.close());
  const options: WatchListOptions = { databasePath: join(root, "threads.sqlite"), threads: owner, intervalMs: 14_400_000,
    placement: destination => ({ ok: true, value: { cwd: root, metadata: { profileId: destination } } }),
    onError: vi.fn(), recoveryEvidence: id => owner.watchRecoveryEvidence(id) };
  const watch = new WatchList(options); owner.setWatchList(watch);
  let current = watch;
  cleanup.push(() => current.close());
  const add = async (what = "Current fixture check", extra = {}) => (value(await current.watch({ action: "add", threadId: "agent", requestId: what, item: { what, why: "Fixture needs current evidence", nextDueAt: 100, ...extra } })) as { item: WatchItem }).item;
  const replace = async (patch: Partial<WatchListOptions>) => {
    await current.close();
    current = new WatchList({ ...options, ...patch }); owner.setWatchList(current); return current;
  };
  return { owner, watch, options, add, replace, allow: () => { available = true; } };
}

it("recovers a proven unlanded failed wake once with fresh current items and configured settings, preserving failed history", async () => {
  const { owner, watch, add, replace, allow } = fixture();
  await owner.start(); const item = await add(); const now = Date.now(); value(await watch.tick(now));
  const original = value(await owner.list()).threads[0]!;
  await until(() => owner.latestSettlement(original.id) !== null);
  const failed = owner.latestSettlement(original.id);
  expect(owner.watchRecoveryEvidence(original.id)).toEqual({ ok: true, value: "unlanded" });
  allow(); const changed = await replace({ settings: value(watchSettings("openai-codex/gpt-6.1-sol")) });
  const request = { action: "checkNow" as const, requestId: "recover-once", threadId: "agent" };
  const receipt = value(await changed.watch(request));
  expect(await changed.watch(request)).toEqual({ ok: true, value: receipt });
  expect(await changed.watch({ ...request, threadId: "other" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  const checks = value(await owner.list()).threads;
  expect(checks).toHaveLength(2);
  const current = checks.find(thread => thread.id !== original.id)!;
  expect(current.settings).toEqual({ model: "openai-codex/gpt-6.1-sol", thinkingLevel: "high", speed: "standard" });
  expect(owner.pending(current.id)[0]!.text).toContain("Current fixture check");
  expect(owner.pending(current.id)[0]!.text).not.toContain("unknown startup ownership");
  expect(owner.latestSettlement(original.id)).toEqual(failed);
  expect(value(await changed.watch({ action: "list", threadId: "agent" }))).toMatchObject({ items: [{ id: item.id, lastThreadId: current.id }] });
  value(await changed.tick(Date.now() + 30_000));
  expect(value(await owner.list()).threads).toHaveLength(2);
  value(await changed.watch({ ...request, requestId: "while-pending" }));
  expect(value(await owner.list()).threads).toHaveLength(2);
});

it.each(["stop", "archive", "questions", "retimed", "removed"] as const)("recovery preserves %s instead of reviving its failed wake", async action => {
  const { owner, watch, add } = fixture(); await owner.start(); const item = await add(); value(await watch.tick(Date.now()));
  const original = value(await owner.list()).threads[0]!; await until(() => owner.latestSettlement(original.id) !== null);
  if (action === "stop") value(await owner.control({ threadId: original.id, action: "stop", descendants: false }));
  if (action === "archive") value(await owner.control({ threadId: original.id, action: "update", archived: true }));
  if (action === "questions") value(await owner.ask({ threadId: original.id, requestId: "decision", questions: [{ question: "Make a commitment?" }] }));
  if (action === "retimed") value(await watch.watch({ action: "update", threadId: "agent", requestId: "retime", id: item.id, patch: { nextDueAt: Date.now() + 86_400_000 } }));
  if (action === "removed") value(await watch.watch({ action: "remove", threadId: "agent", requestId: "remove", id: item.id }));
  expect(value(await watch.watch({ action: "checkNow", requestId: "recovery", threadId: "agent" }))).toMatchObject({ scheduledThreadIds: [] });
  expect(value(await owner.list()).threads).toHaveLength(1);
});

it("does not infer absence of side effects from a terminal failure without native readiness evidence", async () => {
  const { owner, watch, add } = fixture(false); await owner.start(); await add(); value(await watch.tick(Date.now()));
  const original = value(await owner.list()).threads[0]!; await until(() => owner.latestSettlement(original.id) !== null);
  expect(owner.watchRecoveryEvidence(original.id)).toEqual({ ok: true, value: "uncertain" });
  expect(value(await watch.watch({ action: "checkNow", requestId: "manual", threadId: "agent" }))).toEqual({ scheduledThreadIds: [], deferred: [{ threadId: original.id, reason: "uncertain" }] });
});

it("explicit check-now admits unrelated due current items before the interval floor without duplicating pending checks", async () => {
  const { owner, watch, add } = fixture(); await add("First"); value(await watch.tick(100));
  const first = value(await owner.list()).threads[0]!;
  value(await owner.control({ threadId: first.id, action: "stop", descendants: false }));
  await add("New due item"); value(await watch.tick(101)); expect(value(await owner.list()).threads).toHaveLength(1);
  value(await watch.watch({ action: "checkNow", threadId: "agent", requestId: "now" }));
  expect(value(await owner.list()).threads).toHaveLength(2);
  value(await watch.watch({ action: "checkNow", threadId: "agent", requestId: "again" }));
  expect(value(await owner.list()).threads).toHaveLength(2);
});

it("keeps unaccepted delivery failures durable, backs off across reload, and lets the other destination land", async () => {
  const { owner, watch, options, replace, add } = fixture();
  const routed = await replace({ intervalMs: 60_000, destinations: ["personal", "home"] });
  await add("Personal item", { destination: "personal" }); await add("Home item", { destination: "home" });
  const actual = owner.spawn.bind(owner);
  const spawn = vi.spyOn(owner, "spawn").mockImplementation(async input => input.metadata?.watchDestination === "personal"
    ? { ok: false, error: { code: "unavailable", message: "Synthetic owner unavailable" } } : actual(input));
  expect(await routed.tick(100)).toMatchObject({ ok: false });
  expect(value(await owner.list()).threads.map(thread => thread.metadata?.watchDestination)).toEqual(["home"]);
  const failed = spawn.mock.calls.find(([input]) => input.metadata?.watchDestination === "personal")![0];
  const restored = new WatchList({ ...options, intervalMs: 60_000, destinations: ["personal", "home"] }); cleanup.push(() => restored.close());
  expect(await restored.tick(30_100)).toMatchObject({ ok: false }); expect(spawn).toHaveBeenCalledTimes(2);
  expect(await restored.tick(60_100)).toMatchObject({ ok: false }); expect(spawn).toHaveBeenCalledTimes(3);
  expect(spawn.mock.calls[2]![0]).toEqual(failed);
  expect(value(await restored.watch({ action: "list", threadId: "agent" }))).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ what: "Personal item", lastThreadId: failed.id })]) });
});

it("does not spin on permanent delivery or placement configuration errors or block another destination", async () => {
  const { owner, options, replace, add } = fixture();
  const placement = vi.fn<WatchListOptions["placement"]>(destination => destination === "personal"
    ? { ok: false, error: { code: "invalid_request", message: "Invalid placement configuration" } } : options.placement(destination));
  const routed = await replace({ destinations: ["personal", "home"], placement });
  await add("Personal item", { destination: "personal" }); await add("Home item", { destination: "home" });
  expect(await routed.tick(100)).toMatchObject({ ok: false });
  expect(value(await owner.list()).threads).toHaveLength(1);
  expect(await routed.tick(1e8)).toMatchObject({ ok: false }); expect(placement).toHaveBeenCalledTimes(2);
  expect(value(await routed.watch({ action: "list", threadId: "agent" }))).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ what: "Personal item", nextDueAt: 100 })]) });
});

it("a pre-readiness failure while reopening accepted work does not prove that earlier work was unlanded", async () => {
  const { owner, options } = fixture();
  const placement = value(options.placement("home"));
  value(owner.importThread({ id: "retained", title: "Retained watch", cwd: placement.cwd, sessionFile: join(placement.cwd, "retained.jsonl"),
    settings: value(watchSettings(undefined)), metadata: { watchList: true } }));
  value(owner.importMessage({ id: "accepted", threadId: "retained", text: "earlier work", state: "dispatched", executionId: "retained-execution" }));
  await owner.start(); await until(() => owner.latestSettlement("retained") !== null);
  expect(owner.latestSettlement("retained")).toMatchObject({ executionId: "retained-execution", workId: "accepted", outcome: "failed" });
  expect(owner.watchRecoveryEvidence("retained")).toEqual({ ok: true, value: "uncertain" });
});

it("permanent spawn configuration errors retain delivery custody without another automatic spawn", async () => {
  const { owner, watch, add } = fixture(); await add();
  const spawn = vi.spyOn(owner, "spawn").mockResolvedValue({ ok: false, error: { code: "invalid_request", message: "Invalid native settings" } });
  expect(await watch.tick(100)).toMatchObject({ ok: false });
  expect(await watch.tick(1e8)).toMatchObject({ ok: false }); expect(spawn).toHaveBeenCalledTimes(1);
  const receipt = value(await watch.watch({ action: "checkNow", threadId: "agent", requestId: "retry-repaired-config" }));
  expect(receipt).toMatchObject({ scheduledThreadIds: [spawn.mock.calls[0]![0].id] });
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(spawn.mock.calls[1]![0]).toEqual(spawn.mock.calls[0]![0]);
});

it("validates per-owner model settings without changing another owner's declared default", async () => {
  const { watch, options, add, owner, replace } = fixture();
  expect(watchSettings("missing/invalid model")).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect(watchSettings("")).toMatchObject({ ok: false });
  expect(() => new WatchList({ ...options, settings: { model: "bad model", thinkingLevel: "high", speed: "standard" } })).toThrow("Unknown model");
  const configured = await replace({ settings: value(watchSettings("sol")) }); await add(); value(await configured.tick(100));
  expect(value(await owner.list()).threads[0]!.settings.model).toBe("openai-codex/gpt-6.1-sol");
  expect(watchSettings(undefined)).toMatchObject({ ok: true, value: { model: "anthropic/claude-opus-5-5" } });
});
