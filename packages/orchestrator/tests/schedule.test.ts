import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ScheduleService, scheduleHttp } from "../src/schedule.js";
import type { Result, SpawnThread, Thread, ThreadApi, ThreadList, ThreadPage } from "../src/threads/contracts.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function thread(input: SpawnThread, state: Thread["state"] = "running"): Thread {
  return {
    id: input.id!, parentId: null, title: input.title!, cwd: input.cwd, sessionFile: `/sessions/${input.id}.jsonl`,
    settings: { model: input.settings!.model!, thinkingLevel: input.settings!.thinkingLevel!, speed: input.settings!.speed! },
    admission: input.admission ?? "force", state, held: false, revision: 1, createdAt: 0, updatedAt: 0,
    pendingMessages: state === "running" ? 1 : 0, metadata: input.metadata,
  };
}

function fakeThreads(spawn: (input: SpawnThread) => Promise<Result<Thread>>) {
  const records = new Map<string, Thread>();
  const api = {
    async spawn(input: SpawnThread) {
      const result = await spawn(input);
      if (result.ok) records.set(result.value.id, result.value);
      return result;
    },
    async list(input: ThreadList = {}): Promise<Result<ThreadPage>> {
      const threads = [...records.values()].filter(item => !input.id || item.id === input.id);
      return { ok: true, value: { threads } };
    },
  } as ThreadApi;
  return { api, records };
}

function database(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-schedule-"));
  roots.push(root);
  return join(root, "threads.sqlite3");
}

it("runs only the latest missed occurrence and never overlaps its previous thread", async () => {
  let now = 100_000;
  const accepted: SpawnThread[] = [];
  const fake = fakeThreads(async input => {
    accepted.push(input);
    return { ok: true, value: thread(input) };
  });
  const schedules = new ScheduleService({ databasePath: database(), threads: fake.api, now: () => now });
  expect(await schedules.create({ id: "digest", prompt: "Write the digest", cwd: "/work", intervalMs: 10_000, startAt: 0, settings: { model: "sol" } }))
    .toMatchObject({ ok: true, value: { nextRunAt: 0, settings: { model: "openai-codex/gpt-6-sol" } } });

  await schedules.reconcile();
  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({
    requestId: "schedule:digest:100000", id: "schedule:digest:100000", message: "Write the digest",
    metadata: { scheduleId: "digest", scheduledAt: 100_000 },
  });
  expect(schedules.get("digest")).toMatchObject({ ok: true, value: { nextRunAt: 110_000, lastScheduledAt: 100_000 } });

  now = 135_000;
  await schedules.reconcile();
  expect(accepted).toHaveLength(1);
  fake.records.set("schedule:digest:100000", { ...fake.records.get("schedule:digest:100000")!, state: "idle", pendingMessages: 0 });
  await schedules.reconcile();
  expect(accepted.map(item => item.id)).toEqual(["schedule:digest:100000", "schedule:digest:130000"]);
  expect(schedules.get("digest")).toMatchObject({ ok: true, value: { nextRunAt: 140_000 } });
  await schedules.close();
});

it("retries a persisted pending occurrence with the same thread and request identity after restart", async () => {
  const path = database();
  const attempts: SpawnThread[] = [];
  let available = false;
  const fake = fakeThreads(async input => {
    attempts.push(input);
    return available
      ? { ok: true, value: thread(input) }
      : { ok: false, error: { code: "unavailable", message: "controller handoff" } };
  });
  let schedules = new ScheduleService({ databasePath: path, threads: fake.api, now: () => 50_000 });
  await schedules.create({ id: "restart", prompt: "Continue", cwd: "/work", intervalMs: 5_000, startAt: 50_000 });
  await schedules.reconcile();
  expect(attempts).toHaveLength(1);
  expect(schedules.get("restart")).toMatchObject({ ok: true, value: { lastOccurrence: { state: "pending" } } });
  await schedules.close();

  available = true;
  schedules = new ScheduleService({ databasePath: path, threads: fake.api, now: () => 80_000 });
  await schedules.reconcile();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toMatchObject({ requestId: attempts[0]!.requestId, id: attempts[0]!.id });
  expect(schedules.get("restart")).toMatchObject({ ok: true, value: { nextRunAt: 55_000, lastOccurrence: { state: "accepted" } } });
  await schedules.close();
});

it("pauses after a terminal spawn rejection and resumes without deleting its history", async () => {
  let reject = true;
  let now = 10_000;
  const fake = fakeThreads(async input => reject
    ? { ok: false, error: { code: "invalid_request", message: "model removed" } }
    : { ok: true, value: thread(input) });
  const schedules = new ScheduleService({ databasePath: database(), threads: fake.api, now: () => now });
  await schedules.create({ id: "repair", prompt: "Repair", cwd: "/work", intervalMs: 1_000, startAt: 10_000 });
  await schedules.reconcile();
  expect(schedules.get("repair")).toMatchObject({ ok: true, value: { state: "paused", lastError: "model removed", lastOccurrence: { state: "failed" } } });
  reject = false;
  now = 11_000;
  expect(await schedules.resume("repair")).toMatchObject({ ok: true, value: { state: "active" } });
  await schedules.reconcile();
  expect(schedules.get("repair")).toMatchObject({ ok: true, value: { lastOccurrence: { state: "accepted" } } });
  await schedules.close();
});

it("serves create, inspection, pause, resume, and explicit deletion routes", async () => {
  const fake = fakeThreads(async input => ({ ok: true, value: thread(input) }));
  const schedules = new ScheduleService({ databasePath: database(), threads: fake.api, now: () => 1_000 });
  const create = await scheduleHttp(schedules, new Request("http://daemon/v1/schedules", {
    method: "POST", body: JSON.stringify({ id: "daily", prompt: "Check", cwd: "/work", intervalMs: 86_400_000 }),
  }));
  expect(create?.status).toBe(200);
  expect(await create?.json()).toMatchObject({ ok: true, value: { id: "daily", nextRunAt: 86_401_000 } });
  const paused = await scheduleHttp(schedules, new Request("http://daemon/v1/schedules/daily/pause", { method: "POST" }));
  expect(await paused?.json()).toMatchObject({ ok: true, value: { state: "paused" } });
  const resumed = await scheduleHttp(schedules, new Request("http://daemon/v1/schedules/daily/resume", { method: "POST" }));
  expect(await resumed?.json()).toMatchObject({ ok: true, value: { state: "active" } });
  const removed = await scheduleHttp(schedules, new Request("http://daemon/v1/schedules/daily", { method: "DELETE" }));
  expect(await removed?.json()).toEqual({ ok: true, value: { id: "daily", removed: true } });
  expect((await scheduleHttp(schedules, new Request("http://daemon/v1/schedules/daily")))?.status).toBe(404);
  await schedules.close();
});
