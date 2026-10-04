import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { CompletionOutcome, CompletionRecord } from "pi-orchestrator/api";
import { ensureSupervisorSchema, ensureThreadView } from "./database";
import { EngineReservedError } from "./engine-reservation";
import { observeError } from "./error-feedback";
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
  const local = deferred<string>();
  const completion = deferred<Completion>();
  const entered = deferred<void>();
  const writes: { title: string; options: unknown }[] = [];
  let submits = 0;
  const sandbox = {
    ...naming, db, ensureThreadView, observeError, EngineReservedError,
    shuttingDown: false, ROOMS_ENABLED: false, roomMetadata: () => null,
    THREAD_NAMING_MODEL: route === "local" ? "local/engine/model" : "openai/gpt-6-luna:low",
    ORCHESTRATOR_CATALOG: { models: [{ id: "luna", model: "gpt-6-luna" }] },
    AGENT_DIR: "/unused", BACKGROUND_RESERVATION_WAIT_SECONDS: 0,
    recentContextMessages: () => [{ role: "user", text: "ask" }],
    sessionRow: { get: () => ({ name: thread.title, metadata: thread.metadata }) },
    threads: {
      get: () => thread,
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
      submit: () => { submits++; entered.resolve(); return completion.promise; },
      get: () => { entered.resolve(); return completion.promise; },
    },
  };
  const api = runInNewContext(`${worker}\n({ nameThread, clearPinnedThreadNaming, reservedNames })`, sandbox) as {
    nameThread: (id: string) => Promise<void>;
    clearPinnedThreadNaming: (id: string) => boolean;
    reservedNames: Set<string>;
  };
  const view = () => db.query("SELECT naming_request,naming_error,named_at_message_count FROM thread_views WHERE id='thread'").get();
  const pin = () => {
    thread.title = "Pinned Title";
    thread.metadata.titleSource = "manual";
    api.reservedNames.add("thread");
    expect(api.clearPinnedThreadNaming("thread")).toBe(true);
    expect(api.reservedNames.has("thread")).toBe(false);
    expect(view()).toEqual({ naming_request: null, naming_error: null, named_at_message_count: 0 });
  };
  return { db, thread, local, completion, entered, writes, api, view, pin, submits: () => submits };
}

describe("supervisor naming worker", () => {
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
