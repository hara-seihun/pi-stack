import { expect, test } from "bun:test";
import type { Thread, ThreadApi } from "pi-orchestrator/api";
import { archiveInactiveThreads, autoArchiveDelay } from "./auto-archive";

test("disabled by default and validates configuration", () => {
  expect(autoArchiveDelay(undefined)).toBe(0);
  expect(autoArchiveDelay("3600000")).toBe(3600000);
  for (const value of ["-1", "NaN", "1.5"]) expect(() => autoArchiveDelay(value)).toThrow();
});

test("collects all pages before mutation and protects recent or busy descendants", async () => {
  const row = (id: string, patch: Partial<Thread> = {}) => ({ id, parentId: null, state: "idle", updatedAt: 1, pendingMessages: 0, ...patch }) as Thread;
  const rows = [row("parent"), row("stale"), row("recent", { updatedAt: 6_400_000 }), row("child", { parentId: "parent", state: "running" }), row("held", { state: "stopped", pendingMessages: 1 }), row("archived", { metadata: { archived: true } }), row("cancelling", { state: "running", metadata: { executionError: "Cancellation not confirmed" } }), row("failed", { metadata: { executionError: "Provider failed" } })];
  const calls: string[] = [];
  const api = {
    async list({ cursor }: { cursor?: string }) { calls.push(`list:${cursor ?? "first"}`); return { ok: true, value: { threads: cursor ? rows.slice(3) : rows.slice(0, 3), ...(cursor ? {} : { nextCursor: "next" }) } }; },
    async control({ threadId, action, inactiveBefore }: any) { calls.push(threadId); expect(action).toBe("archiveInactive"); expect(inactiveBefore).toBe(6_400_000); return { ok: true, value: row(threadId, { metadata: { archived: true } }) }; },
  } as unknown as ThreadApi;
  expect(await archiveInactiveThreads(api, 3_600_000, 10_000_000)).toBe(2);
  expect(calls).toEqual(["list:first", "list:next", "stale", "failed"]);
  expect(await archiveInactiveThreads(api, 0)).toBe(0);
  expect(await archiveInactiveThreads(api, 1, 10_000_000, () => true)).toBe(0);
});
