import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/store.js";
import { loadConfig } from "../src/config.js";
import { CompletionService } from "../src/completion.js";
import { CompletionPool } from "../src/host/completion-pool.js";
import { assignCompletion } from "../src/policy.js";
import { reservationKey } from "../src/admission-reservation.js";
import type { CompletionExecution, CompletionOutcome } from "../src/completion-contract.js";

function value<T>(outcome: CompletionOutcome<T>): T { if (!outcome.ok) throw new Error(outcome.error.message); return outcome.value; }
const metadata = { caller: "omniscience", purpose: "regulatory-atlas-tagging" };
const result: CompletionExecution = { state: "completed", result: { text: "ok", provider: "openai-codex", model: "gpt-6-luna", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, stopReason: "stop" } };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "completion-pool-")), store = Store.open(":memory:");
  const config = { ...loadConfig("/missing"), agentDir: root, maxConcurrentSessions: 1 };
  const service = new CompletionService(store, root), accountId = "openai-codex-12";
  store.upsertAccount({ id: accountId, provider: "openai-codex", concurrency: 1 });
  store.setControl(reservationKey(accountId), JSON.stringify({ metadata, reason: "Atlas" }));
  for (const meter of ["codex-5h", "codex-7d"]) store.recordMeter(accountId, meter, 83, Date.now() + 86400000, Date.now());
  const submit = (id: string, meta = metadata) => value(service.submit(id, { model: "luna", prompt: id, metadata: meta }));
  const admit = (id: string) => {
    const record = submit(id), choice = assignCompletion(store, record.runId, "luna", config);
    expect(choice.assignment).toBeDefined();
    expect(store.assignRun(record.runId, { ...choice.assignment!, unit: `completion:${record.runId}`, releasePath: "/release" })).toBe(true);
    return store.run(record.runId)!;
  };
  return { store, config, service, accountId, submit, admit, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

it("runs 315 independent requests concurrently despite agent ceilings, preserving IDs and usage", async () => {
  const f = fixture();
  let release!: () => void, calls = 0;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const pool = new CompletionPool(f.store, f.service, f.config, async () => { calls++; await barrier; return result; });
  try {
    for (let n = 0; n < 315; n++) { const run = f.admit(`row-${n}`); pool.start(run); pool.start(run); }
    expect(pool.size).toBe(315); expect(calls).toBe(315);
    expect(f.store.activeLeases()).toHaveLength(315);
    expect(f.store.activeSessionLeases()).toHaveLength(0);
    expect(f.submit("row-0").state).toBe("running");
    release(); await pool.close();
    expect(f.store.runs(["done"])).toHaveLength(315);
    expect(f.store.activeLeases()).toHaveLength(0);
    expect(f.store.usageSince(0).reduce((sum, row) => sum + row.tokens, 0)).toBe(630);
  } finally { release(); await pool.close(); f.close(); }
}, 20_000);

it("keeps reservation, pause, exhaustion, freshness and cooldown as real admission boundaries", () => {
  const f = fixture();
  try {
    const wrong = f.submit("wrong", { caller: "other", purpose: metadata.purpose });
    expect(assignCompletion(f.store, wrong.runId, "luna", f.config).assignment).toBeUndefined();
    const right = f.submit("right");
    f.store.setControl("launches", "paused");
    expect(assignCompletion(f.store, right.runId, "luna", f.config).assignment).toBeUndefined();
    f.store.setControl("launches", "enabled");
    expect(assignCompletion(f.store, right.runId, "luna", f.config, Date.now() + f.config.meterMaxAgeMs + 1).assignment).toBeUndefined();
    f.store.setCooldown(f.accountId, Date.now() + 60000);
    expect(assignCompletion(f.store, right.runId, "luna", f.config).assignment).toBeUndefined();
    f.store.setCooldown(f.accountId, 0);
    f.store.recordMeter(f.accountId, "codex-7d", 100, Date.now() + 86400000, Date.now() + 1);
    expect(assignCompletion(f.store, right.runId, "luna", f.config).assignment).toBeUndefined();
  } finally { f.close(); }
});

it("fences a lost host without redispatch and keeps cancellation leases until provider settlement", async () => {
  const f = fixture(); let calls = 0;
  const pool = new CompletionPool(f.store, f.service, f.config, async (_input, _run, options) => {
    calls++; await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    return { state: "cancelled", error: { code: "cancelled", message: "aborted" } };
  });
  try {
    const lost = f.admit("lost"); value(f.service.claim(lost.id, "previous-process"));
    pool.start(lost); await Promise.resolve();
    expect(f.service.get("lost")?.state).toBe("indeterminate"); expect(calls).toBe(0);
    const cancel = f.admit("cancel"); pool.start(cancel);
    value(f.service.cancel("cancel"));
    expect(f.store.activeLeases(f.accountId)).toHaveLength(1);
    pool.tick(); await pool.close();
    expect(f.service.get("cancel")?.state).toBe("cancelled"); expect(f.store.activeLeases()).toHaveLength(0);
    const shutdown = f.admit("shutdown"); pool.start(shutdown); await pool.close();
    expect(f.service.get("shutdown")?.state).toBe("indeterminate");
  } finally { await pool.close(); f.close(); }
});
