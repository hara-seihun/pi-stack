import { expect, test } from "bun:test";
import type { Thread, ThreadApi } from "pi-orchestrator/api";
import { archiveInactiveThreads } from "./auto-archive";

const hour = 3_600_000;

test("viewing an old idle worker protects it and its conversation for a fresh hour", async () => {
  const rows = [
    { id: "root", parentId: null, state: "idle", updatedAt: 1, pendingMessages: 0, metadata: { autoArchiveViewedAt: 1 } },
    { id: "worker", parentId: "root", state: "idle", updatedAt: 1, pendingMessages: 0, metadata: { autoArchiveViewedAt: 10 * hour } },
  ] as unknown as Thread[];
  const calls: string[] = [];
  const api = {
    async list() { return { ok: true, value: { threads: rows } }; },
    async control({ threadId }: any) { calls.push(threadId); return { ok: true, value: { metadata: { archived: true } } }; },
  } as unknown as ThreadApi;
  expect(await archiveInactiveThreads(api, hour, 10 * hour + 1)).toBe(0);
  expect(calls).toEqual([]);
  expect(await archiveInactiveThreads(api, hour, 11 * hour + 1)).toBe(2);
});

test("an old idle conversation gets a full hour after viewing, and a later view resets it", async () => {
  const root = { id: "root", parentId: null, state: "idle", updatedAt: 1, pendingMessages: 0, metadata: {} } as Thread;
  const calls: string[] = [];
  const api = {
    async list() { return { ok: true, value: { threads: [root] } }; },
    async control({ threadId }: any) { calls.push(threadId); return { ok: true, value: { ...root, metadata: { archived: true } } }; },
  } as unknown as ThreadApi;
  expect(await archiveInactiveThreads(api, hour, 10 * hour)).toBe(0);
  root.metadata!.autoArchiveViewedAt = 10 * hour;
  expect(await archiveInactiveThreads(api, hour, 10 * hour + 1)).toBe(0);
  expect(await archiveInactiveThreads(api, hour, 11 * hour)).toBe(0);
  root.metadata!.autoArchiveViewedAt = 11 * hour;
  expect(await archiveInactiveThreads(api, hour, 11 * hour + 1)).toBe(0);
  expect(await archiveInactiveThreads(api, hour, 12 * hour + 1)).toBe(1);
  expect(calls).toEqual(["root"]);
});

test("new activity invalidates a previous idle view without disabling worker cleanup", async () => {
  const root = { id: "root", parentId: null, state: "idle", updatedAt: 100, pendingMessages: 0, metadata: { autoArchiveViewedAt: 99 } } as unknown as Thread;
  const worker = { id: "worker", parentId: "root", state: "idle", updatedAt: 100, pendingMessages: 0 } as Thread;
  const detachedWorker = { ...worker, id: "detached", parentId: null, role: "worker" } as Thread;
  const calls: string[] = [];
  const api = {
    async list() { return { ok: true, value: { threads: [root, worker, detachedWorker] } }; },
    async control({ threadId }: any) { calls.push(threadId); return { ok: true, value: { metadata: { archived: true } } }; },
  } as unknown as ThreadApi;
  expect(await archiveInactiveThreads(api, hour, 10 * hour)).toBe(2);
  expect(calls).toEqual(["worker", "detached"]);
});
