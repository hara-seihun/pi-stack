import { expect, test } from "bun:test";
import type { Thread, ThreadApi } from "pi-orchestrator/api";
import { createThreadViewRecorder } from "./thread-viewing";

function row(patch: Partial<Thread> = {}): Thread {
  return { id: "thread", state: "idle", updatedAt: 100, pendingMessages: 0, metadata: {}, ...patch } as Thread;
}

test("opening an idle thread records a durable owner view; state refresh does not keep resetting it", async () => {
  let thread = row();
  const calls: unknown[] = [];
  const api = { async control(input: unknown) {
    calls.push(input);
    return { ok: true, value: { ...thread, metadata: { autoArchiveViewedAt: 200 + calls.length } } };
  } } as unknown as ThreadApi;
  const record = createThreadViewRecorder(api, () => thread, value => { thread = value; });
  await record(thread.id, true);
  expect(calls).toEqual([{ threadId: "thread", action: "view" }]);
  expect(thread.updatedAt).toBe(100);
  await record(thread.id);
  expect(calls.length).toBe(1);
  await record(thread.id, true);
  expect(calls.length).toBe(2);
  thread = row({ updatedAt: 300 });
  await record(thread.id);
  expect(calls.length).toBe(3);
});

test("a thread already visible when it settles gets its idle view, but background selection does not", async () => {
  let thread = row({ state: "running" });
  const calls: unknown[] = [];
  const api = { async control(input: unknown) {
    calls.push(input);
    return { ok: true, value: { ...thread, metadata: { autoArchiveViewedAt: 400 } } };
  } } as unknown as ThreadApi;
  const record = createThreadViewRecorder(api, () => thread, value => { thread = value; });
  await record(thread.id);
  expect(calls).toEqual([]);
  thread = row({ updatedAt: 300 });
  await record(thread.id);
  expect(calls.length).toBe(1);
  thread = row({ metadata: { archived: true } });
  await record(thread.id, true);
  expect(calls.length).toBe(1);
});

test("simultaneous viewers coalesce owner writes and failed recording remains retryable", async () => {
  let complete!: (value: unknown) => void;
  const response = new Promise(resolve => { complete = resolve; });
  let count = 0;
  const api = { async control() { count++; return response; } } as unknown as ThreadApi;
  const record = createThreadViewRecorder(api, () => row(), () => {});
  const first = record("thread", true), second = record("thread", true);
  expect(first).toBe(second);
  expect(count).toBe(1);
  complete({ ok: false, error: { message: "Owner unavailable" } });
  await expect(first).rejects.toThrow("Owner unavailable");
  await expect(record("thread", true)).rejects.toThrow("Owner unavailable");
  expect(count).toBe(2);
});
