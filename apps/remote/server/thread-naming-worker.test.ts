import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { CompletionOutcome, CompletionRecord } from "pi-orchestrator/api";
import { ensureSupervisorSchema, ensureThreadView } from "./database";
import { EngineReservedError } from "./engine-reservation";
import { dismissError, observeError, observeFailure } from "./error-feedback";
import * as naming from "./thread-naming";

// Exercise the supervisor's actual worker without starting its HTTP server, runtimes or timers.
const server = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
const workerSource = server.slice(server.indexOf("const namingThreads ="), server.indexOf("function scheduleThreadNameIfDue"));
const worker = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(workerSource);

type Completion = CompletionOutcome<CompletionRecord>;
const completed = (text: string): Completion => ({ ok: true, value: {
  requestId: "receipt", runId: "run", model: "luna", state: "completed", result: { text }, createdAt: 1, updatedAt: 2,
} as CompletionRecord });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(route: "local" | "completion", poll = false) {
  const db = new Database(":memory:");
  ensureSupervisorSchema(db);
  ensureThreadView(db, "thread");
  db.query("UPDATE thread_views SET message_count=40,naming_error='prior error',naming_request=? WHERE id='thread'")
    .run(poll ? JSON.stringify({ requestId: "receipt", messageCount: 40, input: { model: "luna", prompt: "User: ask" } }) : null);
  observeError(db, "naming:thread", "prior error", "0");
  const thread = { title: "47", metadata: {} as Record<string, unknown> };
  let local = deferred<string>();
  let completion = deferred<Completion>();
  let entered = deferred<void>();
  let now = 1_000;
  const writes: { title: string; options: unknown }[] = [];
  const additionalThreads = new Map<string, typeof thread>();
  let submits = 0;
  const requestIds: string[] = [];
  const sandbox = {
    ...naming, db, ensureThreadView, observeFailure, EngineReservedError,
    Date: { now: () => now }, Error,
    shuttingDown: false, ROOMS_ENABLED: false, roomMetadata: () => null,
    THREAD_NAMING_MODEL: route === "local" ? "local/engine/model" : "openai/gpt-6-luna:low",
    ORCHESTRATOR_CATALOG: { models: [{ id: "luna", model: "gpt-6-luna" }] },
    AGENT_DIR: "/unused", BACKGROUND_RESERVATION_WAIT_SECONDS: 0,
    recentContextMessages: () => [{ role: "user", text: "ask" }],
    sessionRow: { get: () => ({ name: thread.title, metadata: thread.metadata }) },
    threads: {
      get: (id: string) => id === "thread" ? thread : additionalThreads.get(id),
      update: (_id: string, patch: { title: string }, options: unknown) => {
        writes.push({ title: patch.title, options });
        thread.title = patch.title;
        thread.metadata.titleSource = "auto";
        return { ok: true, value: thread };
      },
    },
    unwrap: (result: { value: unknown }) => result.value,
    ownsSupervisorLease: () => true, signalSync: () => {},
    loadLocalEngine: async () => ({}), ensureLocalEngine: async () => {},
    withLocalEngine: async (_engine: unknown, _wait: number, run: () => Promise<string>) => run(),
    localNamingCompletion: () => { entered.resolve(); return local.promise; },
    namingClient: {
      submit: (id: string) => { submits++; requestIds.push(id); entered.resolve(); return completion.promise; },
      get: () => { entered.resolve(); return completion.promise; },
    },
  };
  type Api = {
    nameThread: (id: string) => Promise<void>;
    clearPinnedThreadNaming: (id: string) => boolean;
    namingAttention: () => { id: string; message: string } | null;
    restoreThreadNaming: (thread: { id: string; title: string; metadata: Record<string, unknown> }) => void;
    reservedNames: Set<string>;
  };
  const start = () => runInNewContext(`${worker}\n({ nameThread, clearPinnedThreadNaming, namingAttention, restoreThreadNaming, reservedNames })`, sandbox) as Api;
  let api = start();
  const view = () => db.query("SELECT naming_request,naming_error,named_at_message_count FROM thread_views WHERE id='thread'").get();
  const pin = () => {
    thread.title = "Pinned Title";
    thread.metadata.titleSource = "manual";
    api.reservedNames.add("thread");
    expect(api.clearPinnedThreadNaming("thread")).toBe(true);
    expect(api.reservedNames.has("thread")).toBe(false);
    expect(view()).toEqual({ naming_request: null, naming_error: null, named_at_message_count: 0 });
  };
  return {
    db, thread, writes, view, pin, requestIds, sandbox, additionalThreads, submits: () => submits,
    get local() { return local; }, get completion() { return completion; }, get entered() { return entered; }, get api() { return api; },
    nextAttempt(time: number) { now = time; local = deferred<string>(); completion = deferred<Completion>(); entered = deferred<void>(); },
    restart() { api = start(); },
    recovery: () => db.query("SELECT failures,retry_at FROM thread_naming_recovery WHERE id='thread'").get(),
  };
}

describe("supervisor naming worker", () => {
  test("startup preserves stale visible evidence and adopts failed names into bounded recovery", async () => {
    const f = fixture("completion");
    try {
      expect(dbError(f.db)).toBeNull();
      expect(f.db.query("SELECT message FROM error_diagnostics WHERE source='naming:thread'").get()).toMatchObject({ message: "prior error" });
      f.api.restoreThreadNaming({ id: "thread", ...f.thread });
      expect(f.recovery()).toEqual({ failures: 1, retry_at: 31_000 });
      expect(f.api.namingAttention()).toBeNull();
      f.restart();
      f.api.restoreThreadNaming({ id: "thread", ...f.thread });
      expect(f.recovery()).toEqual({ failures: 1, retry_at: 31_000 });
      f.nextAttempt(30_999);
      await f.api.nameThread("thread");
      expect(f.submits()).toBe(0);
      f.thread.metadata.archived = true;
      f.api.restoreThreadNaming({ id: "thread", ...f.thread });
      expect(f.recovery()).toBeNull();
      expect(f.view()).toMatchObject({ naming_error: null });
      expect(f.db.query("SELECT message,resolved_at FROM error_diagnostics WHERE source='naming:thread'").get()).toMatchObject({ message: "prior error", resolved_at: expect.any(Number) });
    } finally { f.db.close(); }
  });

  test("startup resolves stale visible naming occurrences whose operation already succeeded", () => {
    const f = fixture("completion");
    try {
      f.db.query("UPDATE thread_views SET naming_error=NULL WHERE id='thread'").run();
      observeError(f.db, "naming:thread", "stale invalid title");
      f.restart();
      expect(dbError(f.db)).toBeNull();
      expect(f.db.query("SELECT message,resolved_at FROM error_diagnostics WHERE source='naming:thread'").get())
        .toMatchObject({ message: "stale invalid title", resolved_at: expect.any(Number) });
    } finally { f.db.close(); }
  });

  test.each(["title", "invalid", "reserved", "error"])("discards in-flight local %s after a manual rename", async outcome => {
    const f = fixture("local");
    try {
      const run = f.api.nameThread("thread");
      await f.entered.promise;
      f.pin();
      if (outcome === "reserved") f.local.reject(new EngineReservedError("engine", "maintenance"));
      else if (outcome === "error") f.local.reject(new Error("provider failure"));
      else f.local.resolve(outcome === "invalid" ? "1" : "Automatic Title");
      await run;
      expect(f.thread.title).toBe("Pinned Title");
      expect(f.writes).toEqual([]);
      expect(f.view()).toEqual({ naming_request: null, naming_error: null, named_at_message_count: 0 });
      expect(f.api.reservedNames.has("thread")).toBe(false);
      expect(dbError(f.db)).toBeNull();
    } finally { f.db.close(); }
  });

  test.each(["title", "invalid", "failure", "not-found", "throw"])("discards in-flight completion %s after a manual rename", async outcome => {
    const f = fixture("completion", outcome === "not-found");
    try {
      const run = f.api.nameThread("thread");
      await f.entered.promise;
      f.pin();
      if (outcome === "throw") f.completion.reject(new Error("transport failure"));
      else if (outcome === "failure" || outcome === "not-found") f.completion.resolve({ ok: false, error: { code: outcome === "failure" ? "transport" : "not-found", message: "failure" } });
      else f.completion.resolve(completed(outcome === "invalid" ? "1" : "Automatic Title"));
      await run;
      expect(f.thread.title).toBe("Pinned Title");
      expect(f.writes).toEqual([]);
      expect(f.submits()).toBe(outcome === "not-found" ? 0 : 1);
      expect(f.view()).toEqual({ naming_request: null, naming_error: null, named_at_message_count: 0 });
      expect(dbError(f.db)).toBeNull();
    } finally { f.db.close(); }
  });

  test.each(["local", "completion"] as const)("invalid %s titles recover without attention, including after restart", async route => {
    const f = fixture(route);
    try {
      const first = f.api.nameThread("thread");
      await f.entered.promise;
      if (route === "local") f.local.resolve("1"); else f.completion.resolve(completed("1"));
      await first;
      expect(f.thread.title).toBe("47");
      expect(f.recovery()).toEqual({ failures: 1, retry_at: 31_000 });
      expect(dbError(f.db)).toBeNull();
      expect(f.api.namingAttention()).toBeNull();
      expect(f.view()).toMatchObject({ naming_error: "Thread naming model returned an invalid title" });
      expect(f.db.query("SELECT message FROM error_diagnostics WHERE source='naming:thread'").get()).toMatchObject({ message: "Thread naming model returned an invalid title" });
      f.restart();
      f.nextAttempt(30_999);
      await f.api.nameThread("thread");
      expect(f.writes).toEqual([]);
      expect(f.submits()).toBe(route === "completion" ? 1 : 0);
      f.nextAttempt(31_000);
      const retry = f.api.nameThread("thread");
      await f.entered.promise;
      if (route === "local") f.local.resolve("Recovered Title"); else f.completion.resolve(completed("Recovered Title"));
      await retry;
      expect(f.thread.title).toBe("Recovered Title");
      expect(f.recovery()).toBeNull();
      expect(f.view()).toMatchObject({ naming_error: null });
      expect(f.api.namingAttention()).toBeNull();
      if (route === "completion") expect(new Set(f.requestIds).size).toBe(2);
    } finally { f.db.close(); }
  });

  test("exhaustion parks retries and consolidates persistent attention across threads", async () => {
    const f = fixture("completion");
    try {
      for (const time of [1_000, 31_000, 151_000]) {
        f.nextAttempt(time);
        const run = f.api.nameThread("thread");
        await f.entered.promise;
        f.completion.resolve(completed("1"));
        await run;
      }
      expect(f.recovery()).toEqual({ failures: 3, retry_at: null });
      expect(new Set(f.requestIds).size).toBe(3);
      expect(dbError(f.db)).toBeNull();
      const attention = f.api.namingAttention()!;
      expect(attention.message).not.toContain("invalid title");
      expect(attention.message).toContain("current titles");
      expect(dismissError(f.db, attention.id)).toBe(true);
      ensureThreadView(f.db, "second");
      f.additionalThreads.set("second", { title: "48", metadata: {} });
      f.db.query("UPDATE thread_views SET naming_error='raw failure' WHERE id='second'").run();
      f.db.query("INSERT INTO thread_naming_recovery VALUES('second',?,40,3,NULL)").run(f.sandbox.THREAD_NAMING_MODEL);
      expect(f.api.namingAttention()).toBeNull();
      f.restart();
      f.nextAttempt(999_999);
      await f.api.nameThread("thread");
      expect(f.submits()).toBe(3);
      expect(f.writes).toEqual([]);
      f.pin();
      expect(f.recovery()).toBeNull();
    } finally { f.db.close(); }
  });

  test("transport recovery polls the saved receipt rather than submitting another inference", async () => {
    const f = fixture("completion");
    try {
      const run = f.api.nameThread("thread");
      await f.entered.promise;
      f.completion.resolve({ ok: false, error: { code: "transport", message: "socket closed" } });
      await run;
      expect(f.view()).toMatchObject({ naming_error: "socket closed" });
      expect(f.api.namingAttention()).toBeNull();
      f.nextAttempt(31_000);
      const retry = f.api.nameThread("thread");
      await f.entered.promise;
      f.completion.resolve(completed("Recovered Title"));
      await retry;
      expect(f.submits()).toBe(1);
      expect(f.thread.title).toBe("Recovered Title");
    } finally { f.db.close(); }
  });

  test("a rejected configuration requires repair immediately, but a new message resets recovery", async () => {
    const f = fixture("completion");
    try {
      const run = f.api.nameThread("thread");
      await f.entered.promise;
      f.completion.resolve({ ok: false, error: { code: "unsupported-option", message: "raw provider option rejection" } });
      await run;
      expect(f.recovery()).toEqual({ failures: 1, retry_at: null });
      expect(f.api.namingAttention()?.message).not.toContain("provider option");
      f.nextAttempt(999_999);
      await f.api.nameThread("thread");
      expect(f.submits()).toBe(1);
      f.db.query("UPDATE thread_views SET message_count=41 WHERE id='thread'").run();
      const next = f.api.nameThread("thread");
      await f.entered.promise;
      f.completion.resolve(completed("Recovered Title"));
      await next;
      expect(f.thread.title).toBe("Recovered Title");
      expect(f.api.namingAttention()).toBeNull();
    } finally { f.db.close(); }
  });

  test("a naming-model repair opens a fresh episode instead of resetting budget on every restart", async () => {
    const f = fixture("completion");
    try {
      Object.assign(f.sandbox, { namingClient: null });
      await f.api.nameThread("thread");
      expect(f.recovery()).toEqual({ failures: 1, retry_at: null });
      expect(f.api.namingAttention()).not.toBeNull();
      Object.assign(f.sandbox, {
        THREAD_NAMING_MODEL: "openai/gpt-6-luna:medium",
        namingClient: { submit: () => { f.entered.resolve(); return f.completion.promise; } },
      });
      f.restart();
      f.api.restoreThreadNaming({ id: "thread", ...f.thread });
      expect(f.recovery()).toBeNull();
      const run = f.api.nameThread("thread");
      await f.entered.promise;
      f.completion.resolve(completed("Repaired Title"));
      await run;
      expect(f.thread.title).toBe("Repaired Title");
      expect(f.api.namingAttention()).toBeNull();
    } finally { f.db.close(); }
  });

  test("maintenance deferral does not consume recovery budget or raise attention", async () => {
    const f = fixture("local");
    try {
      const run = f.api.nameThread("thread");
      await f.entered.promise;
      f.local.reject(new EngineReservedError("engine", "maintenance"));
      await run;
      expect(f.recovery()).toBeNull();
      expect(f.api.reservedNames.has("thread")).toBe(true);
      expect(f.api.namingAttention()).toBeNull();
      expect(dbError(f.db)).toBeNull();
    } finally { f.db.close(); }
  });

  test("missing completion ownership is unavailable, not an automatic transport attempt", async () => {
    const f = fixture("completion");
    try {
      Object.assign(f.sandbox, { namingClient: null });
      await f.api.nameThread("thread");
      expect(f.recovery()).toEqual({ failures: 1, retry_at: null });
      expect(f.api.namingAttention()).not.toBeNull();
      expect(f.thread.title).toBe("47");
      expect(f.submits()).toBe(0);
    } finally { f.db.close(); }
  });

  test.each(["local", "completion"] as const)("unpinned %s output uses automatic title writes", async route => {
    const f = fixture(route);
    try {
      const run = f.api.nameThread("thread");
      await f.entered.promise;
      if (route === "local") f.local.resolve("Automatic Title");
      else f.completion.resolve(completed("Automatic Title"));
      await run;
      expect(f.writes).toEqual([{ title: "Automatic Title", options: { automaticTitle: true } }]);
      expect(f.view()).toEqual({ naming_request: null, naming_error: null, named_at_message_count: 40 });
    } finally { f.db.close(); }
  });
});

function dbError(db: Database) {
  return db.query("SELECT message FROM error_feedback WHERE source='naming:thread'").get();
}

const peerWorker = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(
  server.slice(server.indexOf("const peerThreads ="), server.indexOf("const inspectingThreads =")),
);
function peerFixture() {
  const db = new Database(":memory:");
  ensureSupervisorSchema(db);
  let now = 1_000;
  let page: { ok: false; error: { message: string } } | { ok: true; value: { threads: { id: string; revision: number }[] } }
    = { ok: true, value: { threads: [{ id: "worker", revision: 1 }] } };
  let duplicate = false;
  let notificationsFail = false;
  let signals = 0;
  const sandbox = {
    db, ensureThreadView, Error,
    observeFailure: (...args: Parameters<typeof observeFailure>) => observeFailure(args[0], args[1], args[2], args[3], now),
    fleet: { list: async () => page },
    threads: { get: () => duplicate ? { id: "worker" } : undefined },
    directory: { owners: [{ id: "fleet", api: {} }] },
    projectThreadNotifications: async () => { if (notificationsFail) throw new Error("raw socket failure"); },
    cachedThreadLookup: () => () => undefined, noteModelRecency: () => {}, pushNotifications: () => {},
    signalSync: () => { signals++; },
  };
  const api = runInNewContext(`${peerWorker}\n({ refreshPeers, refreshThreadNotifications, peerThreads,
    peerAttention: () => peerFeedback(peerError), notificationAttention: () => notificationFeedback('fleet', notificationErrors.get('fleet') ?? null) })`, sandbox) as {
    refreshPeers: () => Promise<void>; refreshThreadNotifications: () => Promise<void>;
    peerThreads: Map<string, unknown>;
    peerAttention: () => { id: string; message: string } | null;
    notificationAttention: () => { id: string; message: string } | null;
  };
  return { db, api, time: (value: number) => { now = value; }, signals: () => signals,
    fail: () => { page = { ok: false, error: { message: "raw peer transport failure" } }; },
    recover: () => { page = { ok: true, value: { threads: [{ id: "worker", revision: 1 }] } }; },
    duplicate: () => { duplicate = true; }, notificationsFail: (value: boolean) => { notificationsFail = value; },
  };
}

describe("supervisor background refresh attention", () => {
  test("peer transport retries retain status and surface only the ongoing effect after grace", async () => {
    const f = peerFixture();
    try {
      await f.api.refreshPeers();
      expect(f.api.peerThreads.size).toBe(1);
      f.fail();
      await f.api.refreshPeers();
      expect(f.api.peerAttention()).toBeNull();
      const signals = f.signals();
      f.time(60_999);
      await f.api.refreshPeers();
      expect(f.api.peerAttention()).toBeNull();
      f.time(61_000);
      await f.api.refreshPeers();
      const attention = f.api.peerAttention()!;
      expect(attention.message).toContain("last available listing");
      expect(attention.message).not.toContain("transport failure");
      expect(f.signals()).toBeGreaterThan(signals);
      expect(f.api.peerThreads.size).toBe(1);
      expect(dismissError(f.db, attention.id)).toBe(true);
      await f.api.refreshPeers();
      expect(f.api.peerAttention()).toBeNull();
      f.recover();
      await f.api.refreshPeers();
      expect(f.api.peerAttention()).toBeNull();
    } finally { f.db.close(); }
  });

  test("conflicting peer ownership needs repair immediately rather than a transport grace", async () => {
    const f = peerFixture();
    try {
      f.duplicate();
      await f.api.refreshPeers();
      expect(f.api.peerAttention()?.message).toContain("conflicting owners");
      expect(f.api.peerAttention()?.message).toContain("repair");
    } finally { f.db.close(); }
  });

  test("idle notification retries suppress raw failures, then report delayed notifications", async () => {
    const f = peerFixture();
    try {
      f.notificationsFail(true);
      await f.api.refreshThreadNotifications();
      expect(f.api.notificationAttention()).toBeNull();
      f.time(61_000);
      await f.api.refreshThreadNotifications();
      expect(f.api.notificationAttention()?.message).toContain("Idle notifications are delayed");
      expect(f.api.notificationAttention()?.message).not.toContain("socket");
      f.notificationsFail(false);
      await f.api.refreshThreadNotifications();
      expect(f.api.notificationAttention()).toBeNull();
    } finally { f.db.close(); }
  });
});
