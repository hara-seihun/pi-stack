import { expect, test } from "bun:test";
import type { Thread, ThreadApi } from "pi-orchestrator/api";
import { archiveInactiveThreads, autoArchiveDelay } from "./auto-archive";

const row = (id: string, patch: Partial<Thread> = {}): Thread => ({ id, parentId: null, state: "idle", updatedAt: 1, pendingMessages: 0, metadata: { foreground: true, autoArchiveViewedAt: 2 }, ...patch } as Thread);
function apiFor(rows: Thread[], calls: unknown[]): ThreadApi {
  return {
    async list({ cursor }: { cursor?: string }) { calls.push(`list:${cursor ?? "first"}`); return { ok: true, value: { threads: cursor ? rows.slice(2) : rows.slice(0, 2), ...(cursor || rows.length <= 2 ? {} : { nextCursor: "next" }) } }; },
    async control(input: any) { calls.push(input); return { ok: true, value: { ...rows.find(row => row.id === input.threadId), metadata: { archived: true } } }; },
  } as unknown as ThreadApi;
}

test("disabled by default and validates configured delay", () => {
  expect(autoArchiveDelay(undefined)).toBe(0); expect(autoArchiveDelay("3600000")).toBe(3600000);
  for (const value of ["-1", "NaN", "1.5"]) expect(() => autoArchiveDelay(value)).toThrow();
});

test("all pages are read before selected-only mutation; active launch descendants do not retain launcher", async () => {
  const calls: unknown[] = [];
  const rows = [row("launcher"), row("busy", { parentId: "launcher", state: "running" }), row("old"), row("recent", { updatedAt: 9000 }), row("queued", { pendingMessages: 1 }), row("archived", { metadata: { archived: true } })];
  const api = apiFor(rows, calls);
  expect(await archiveInactiveThreads(api, 1000, 10000)).toBe(2);
  expect(calls).toEqual(["list:first", "list:next", { threadId: "launcher", action: "archiveInactive", inactiveBefore: 9000 }, { threadId: "old", action: "archiveInactive", inactiveBefore: 9000 }]);
});

test("placement and provenance never override unread, unseen or live retention", async () => {
  const calls: unknown[] = [];
  const rows = [row("unread", { metadata: { foreground: false, autoArchiveViewedAt: 2 } }), row("unseen", { parentId: "gone", metadata: { foreground: false } }), row("live"), row("read", { parentId: "gone", metadata: { foreground: false, autoArchiveViewedAt: 2 } })];
  expect(await archiveInactiveThreads(apiFor(rows, calls), 1000, 10000, () => false, thread => thread.id === "unread", thread => thread.id === "live")).toBe(1);
  expect(calls.at(-1)).toEqual({ threadId: "read", action: "archiveInactive", inactiveBefore: 9000 });
});

test("live dependencies and waits protect both endpoints, while independent agents and inert edges can archive", async () => {
  const calls: unknown[] = [];
  const rows = [row("dependent", { dependencies: ["dependency"] }), row("dependency", { state: "running" }), row("waiting", { waitingOnAgents: { kind: "message", fromThreadId: "sender", since: 1, reason: "Need answer" } }), row("sender"), row("independent")];
  expect(await archiveInactiveThreads(apiFor(rows, calls), 1000, 10000)).toBe(1);
  expect(calls.at(-1)).toEqual({ threadId: "independent", action: "archiveInactive", inactiveBefore: 9000 });
});

test("an inert dependency (settled target, dependent not waiting) does not protect either endpoint", async () => {
  const calls: unknown[] = [];
  expect(await archiveInactiveThreads(apiFor([row("dependent", { dependencies: ["settled"] }), row("settled")], calls), 1000, 10000)).toBe(2);
});

test("a racing owner dependency refusal is retained without aborting the sweep", async () => {
  const calls: unknown[] = [];
  const api = apiFor([row("racing"), row("safe")], calls);
  const control = api.control;
  api.control = async input => input.threadId === "racing" ? { ok: false, error: { code: "dependency_conflict", message: "New dependency" } } : control(input);
  expect(await archiveInactiveThreads(api, 1000, 10000)).toBe(1);
});
