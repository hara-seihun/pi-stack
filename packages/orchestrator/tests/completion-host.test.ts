import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { loadConfig } from "../src/config.js";
import { CompletionService } from "../src/completion.js";
import { CompletionPool } from "../src/host/completion-pool.js";
import { completionHostEntry, completionHostSocket, type CompletionHostBoundary } from "../src/host/completion-transport.js";
import { assignCompletion } from "../src/policy.js";
import { noModelPolicy } from "./fixtures/model-availability.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "completion-host-")), ledgerPath = join(root, "ledger.sqlite3"), socketPath = join(root, "owner.sock");
  let store = Store.open(ledgerPath), service = new CompletionService(store, root);
  const config = { ...loadConfig("/missing"), agentDir: root, authPath: join(root, "auth.json") };
  const accountId = "openai-codex-12";
  store.upsertAccount({ id: accountId, provider: "openai-codex", concurrency: 10 });
  for (const meter of ["codex-5h", "codex-7d"]) store.recordMeter(accountId, meter, 10, Date.now() + 86400000, Date.now());
  const workers: ChildProcess[] = [];
  symlinkSync(resolve("../../node_modules"), join(root, "node_modules"));
  const worker = join(root, "worker.mjs");
  buildSync({ entryPoints: [resolve("tests/fixtures/completion-host-worker.ts")], outfile: worker, platform: "node", format: "esm", packages: "external", bundle: true, logLevel: "silent" });
  const launch = async (boundary: CompletionHostBoundary, socket: string) => {
    const log = openSync(join(root, "worker.log"), "a");
    try { workers.push(spawn("/usr/bin/flock", ["--no-fork", "--nonblock", "--conflict-exit-code", "75", `${socket}.lock`,
      process.execPath, worker, root, socket, boundary.ledgerPath, boundary.authPath, boundary.agentDir], { stdio: ["ignore", log, log] })); }
    finally { closeSync(log); }
  };
  const admit = (id: string) => {
    const submitted = service.submit(id, { model: "luna", thinkingLevel: "low", speed: "standard", prompt: id, metadata: { caller: "fixture", purpose: "durable" } });
    if (!submitted.ok) throw new Error(submitted.error.message);
    const runId = submitted.value.runId;
    const choice = assignCompletion(store, runId, "luna", config, noModelPolicy);
    expect(choice.assignment).toBeDefined();
    expect(store.assignRun(runId, { ...choice.assignment!, unit: `completion:${runId}`, releasePath: "/release" })).toBe(true);
    return store.run(runId)!;
  };
  const controllers: CompletionPool[] = [];
  const controller = () => { const pool = new CompletionPool(store, service, config, { socketPath, launch }); controllers.push(pool); return pool; };
  const calls = () => existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8").trim().split("\n") : [];
  const reopen = () => { store.close(); store = Store.open(ledgerPath); service = new CompletionService(store, root); };
  const clean = async () => {
    for (const pool of controllers) pool.detach();
    for (const child of workers) if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit"); child.kill("SIGKILL"); await ended;
    }
    store.close(); rmSync(root, { recursive: true, force: true });
  };
  return { root, ledgerPath, socketPath, config, workers, launch, admit, controller, calls, reopen, clean,
    store: () => store, service: () => service, release: () => writeFileSync(join(root, "release"), "ok") };
}

it("detach and ledger replacement preserve the independent PID, exact claim, result and usage without redispatch", async () => {
  const f = fixture();
  try {
    const run = f.admit("accepted"), old = f.controller();
    old.start(run);
    await vi.waitFor(() => expect(f.calls()).toEqual([run.id]), { interval: 10 });
    const pid = readFileSync(join(f.root, "host-pid"), "utf8"), attempt = f.service().attempts("accepted")![0]!.attemptId;
    const began = performance.now(); old.detach(); expect(performance.now() - began).toBeLessThan(50);
    expect(() => old.start(run)).toThrow("detached"); expect(() => old.tick()).toThrow("detached");
    f.reopen();
    const successor = f.controller(); successor.start(f.store().run(run.id)!);
    await vi.waitFor(() => expect(f.store().control(`completion-host-error:${run.id}`)).toBe(""), { interval: 10 });
    expect(f.workers).toHaveLength(1); expect(readFileSync(join(f.root, "host-pid"), "utf8")).toBe(pid);
    f.release();
    await vi.waitFor(() => expect(f.service().get("accepted")?.state).toBe("completed"), { interval: 10 });
    expect(f.calls()).toEqual([run.id]); expect(f.service().attempts("accepted")).toHaveLength(1);
    expect(f.service().attempts("accepted")![0]!.attemptId).toBe(attempt);
    expect(f.store().activeLeases()).toHaveLength(0);
    expect(f.store().usageSince(0).reduce((sum, row) => sum + row.tokens, 0)).toBe(2);
  } finally { await f.clean(); }
});

it("the independent host observes explicit cancellation and releases its lease even with no controller", async () => {
  const f = fixture();
  try {
    const run = f.admit("cancel"), pool = f.controller(); pool.start(run);
    await vi.waitFor(() => expect(f.calls()).toEqual([run.id]), { interval: 10 });
    pool.detach();
    const cancelled = f.service().cancel("cancel"); expect(cancelled.ok).toBe(true);
    expect(f.store().activeLeases()).toHaveLength(1);
    await vi.waitFor(() => expect(f.store().activeLeases()).toHaveLength(0), { interval: 10 });
    expect(f.service().get("cancel")?.state).toBe("cancelled");
    expect(f.service().attempts("cancel")![0]!.outcome?.state).toBe("cancelled");
  } finally { await f.clean(); }
});

it("a killed provider owner is fenced by its previous claim, never dispatched again", async () => {
  const f = fixture();
  try {
    const run = f.admit("lost"), pool = f.controller(); pool.start(run);
    await vi.waitFor(() => expect(f.calls()).toEqual([run.id]), { interval: 10 });
    const child = f.workers[0]!, ended = once(child, "exit"); child.kill("SIGKILL"); await ended;
    pool.detach(); f.reopen();
    const successor = f.controller(); successor.start(f.store().run(run.id)!);
    await vi.waitFor(() => expect(f.service().get("lost")?.state).toBe("indeterminate"), { interval: 10 });
    expect(f.calls()).toEqual([run.id]); expect(f.service().attempts("lost")).toHaveLength(1);
    expect(f.store().activeLeases()).toHaveLength(0);
  } finally { await f.clean(); }
});

it("memory controllers can detach but cannot admit execution; paths are ledger-bound, not release-bound", () => {
  const store = Store.open(":memory:"), config = loadConfig("/missing"), pool = new CompletionPool(store, new CompletionService(store, "/"), config);
  try {
    pool.tick(); pool.detach();
    expect(() => new CompletionPool(store, new CompletionService(store, "/"), config).start({ id: "run", workerUnit: "completion:run" } as any)).toThrow("persistent ledger");
    expect(completionHostSocket("/ledger")).toBe(completionHostSocket("/ledger"));
    expect(completionHostSocket("/ledger")).not.toBe(completionHostSocket("/other"));
    expect(completionHostEntry("file:///release/src/host/completion-transport.ts")).toBe("/release/dist/host/completion-host.js");
    expect(completionHostEntry("file:///release/dist/host/completion-transport.js")).toBe("/release/dist/host/completion-host.js");
  } finally { store.close(); }
});

it("pending local observation is cancelled immediately without writing to a detached store", async () => {
  const f = fixture(); let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const run = f.admit("pending");
  const pool = new CompletionPool(f.store(), f.service(), f.config, { socketPath: f.socketPath, launch: async () => pending });
  try {
    pool.start(run); await new Promise(resolve => setTimeout(resolve, 20));
    pool.detach(); f.reopen(); release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.service().get("pending")?.state).toBe("queued");
    expect(f.service().attempts("pending")).toHaveLength(0);
    expect(f.calls()).toEqual([]);
  } finally { release(); pool.detach(); await f.clean(); }
});
