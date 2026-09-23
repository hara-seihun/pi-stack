import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CompletionService } from "../src/completion.js";
import { CompletionClient } from "../src/completion-client.js";
import { COMPLETION_OPENAPI } from "../src/completion-openapi.js";
import { type CompletionExecution, type CompletionInput, type CompletionOutcome, isCompletionInput, isCompletionRecord } from "../src/completion-contract.js";
import { reconcileCompletionReceipts, saveCompletionReceipt } from "../src/host/completion-receipts.js";
import { Store } from "../src/store.js";
import { loadConfig } from "../src/config.js";
import { assignCompletion } from "../src/policy.js";

const input: CompletionInput = { model: "luna", prompt: "  exact user\n", systemPrompt: "exact system", metadata: { application: "test", nested: { b: 2, a: 1 } } };
const execution: CompletionExecution = { state: "completed", result: { text: "  exact result\n", provider: "openai-codex", model: "gpt-6-luna", responseId: "resp-provider", usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, totalTokens: 16, reasoning: 1 }, stopReason: "stop" } };
function value<T>(result: CompletionOutcome<T>): T { if (!result.ok) throw new Error(result.error.message); return result.value; }
function assign(store: Store, id: string) {
  store.upsertAccount({ id: "openai-codex-9", provider: "openai-codex" });
  expect(store.assignRun(id, { accountId: "openai-codex-9", provider: "openai-codex", model: "gpt-6-luna", unit: `run-${id}`, releasePath: "/release" })).toBe(true);
}

describe("durable completions", () => {
  it("rejects unsupported caps and invalid input before creating a run", () => {
    const store = Store.open(":memory:"), service = new CompletionService(store, "/tmp");
    try {
      expect(service.submit("cap", { ...input, maxOutputTokens: 128 })).toMatchObject({ ok: false, error: { code: "unsupported-option" } });
      expect(service.submit("wrong", { ...input, model: "astra" })).toMatchObject({ ok: false, error: { code: "invalid-request" } });
      expect(isCompletionInput({ ...input, tools: ["bash"] })).toBe(false);
      expect(service.submit("openapi.json", input)).toMatchObject({ ok: false, error: { code: "invalid-request" } });
      expect(store.runs()).toHaveLength(0);
    } finally { store.close(); }
  });

  it("commits the request and run together, replays across restart, and refuses changed input", () => {
    const root = mkdtempSync(join(tmpdir(), "completion-")), path = join(root, "ledger.sqlite3");
    let store = Store.open(path);
    try {
      let service = new CompletionService(store, root);
      const first = value(service.submit("application:stable-id", input));
      expect(store.run(first.runId)?.prompt).toBe(input.prompt);
      store.close(); store = Store.open(path); service = new CompletionService(store, root);
      expect(value(service.submit(first.requestId, { ...input, metadata: { nested: { a: 1, b: 2 }, application: "test" } }))).toEqual(first);
      expect(service.submit(first.requestId, { ...input, systemPrompt: "changed" })).toMatchObject({ ok: false, error: { code: "request-conflict" } });
      expect(store.runs()).toHaveLength(1);
      const write = vi.spyOn(store, "setControl").mockImplementationOnce(() => { throw new Error("storage defect"); });
      expect(() => service.submit("failed-commit", input)).toThrow("storage defect");
      write.mockRestore();
      expect(store.runs()).toHaveLength(1);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ["luna", undefined, "max"],
    ["luna", "high", "high"],
    ["luna", "medium", "medium"],
    ["luna", "off", "off"],
  ] as const)("persists %s thinking %s at admission and retains it on retry", (model, thinkingLevel, expected) => {
    const store = Store.open(":memory:"), service = new CompletionService(store, "/tmp");
    const config = loadConfig("/missing");
    try {
      store.upsertAccount({ id: "account", provider: "openai-codex" });
      store.recordMeter("account", "weekly", 1, Date.now() + 60_000);
      const record = value(service.submit("thinking", { ...input, model, thinkingLevel }));
      const first = assignCompletion(store, record.runId, model, config).assignment!;
      expect(first).toMatchObject({ model: `gpt-6-${model}`, thinking: expected });
      expect(store.assignRun(record.runId, { ...first, unit: "completion", releasePath: "/release" })).toBe(true);
      expect(store.run(record.runId)?.thinking).toBe(expected);
      value(service.claim(record.runId, "rejected"));
      const queued = value(service.settle(record.runId, "rejected", { state: "failed", error: { code: "rate-limited", httpStatus: 429, message: "rejected", retryAfterMs: 1000 } }));
      const changed = { ...config, profiles: { [model]: [{ provider: "openai-codex", model: "gpt-6-astra", thinking: "low" }] } };
      const retry = assignCompletion(store, record.runId, model, changed, queued.retryAt! + 1).assignment!;
      expect(retry).toMatchObject({ model: first.model, thinking: expected });
      expect(store.assignRun(record.runId, { ...retry, unit: "retry", releasePath: "/next-release" })).toBe(true);
      expect(store.run(record.runId)?.thinking).toBe(expected);
      expect(service.attempts("thinking")?.[0]?.outcome).toMatchObject({ state: "failed", error: { httpStatus: 429 } });
    } finally { store.close(); }
  });

  it("fences an interrupted provider attempt without creating another spend", () => {
    const store = Store.open(":memory:"), service = new CompletionService(store, "/tmp");
    try {
      const first = value(service.submit("uncertain", input)); assign(store, first.runId);
      expect(value(service.claim(first.runId, "attempt-one")).execute).toBe(true);
      expect(value(service.claim(first.runId, "attempt-one")).input).toEqual(input);
      expect(value(service.claim(first.runId, "attempt-two"))).toMatchObject({ execute: false, record: { state: "indeterminate" } });
      expect(value(service.submit("uncertain", input)).state).toBe("indeterminate");
      expect(store.runs()).toHaveLength(1);
    } finally { store.close(); }
  });

  it("reconciles a saved receipt after an old run failed and records usage exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "completion-receipt-")), path = join(root, "ledger.sqlite3"), receipts = join(root, "completion-receipts");
    let store = Store.open(path);
    try {
      let service = new CompletionService(store, root);
      const first = value(service.submit("receipt", input)); assign(store, first.runId);
      value(service.claim(first.runId, "attempt"));
      saveCompletionReceipt(receipts, { runId: first.runId, attemptId: "attempt", outcome: execution });
      store.updateRun(first.runId, { state: "failed", failureKind: "infrastructure", result: "host stopped" });
      store.close(); store = Store.open(path); service = new CompletionService(store, root);
      expect(reconcileCompletionReceipts(service, receipts)).toBe(1);
      expect(reconcileCompletionReceipts(service, receipts)).toBe(0);
      expect(service.get("receipt")).toMatchObject({ state: "completed", result: execution.result });
      expect(store.run(first.runId)).toMatchObject({ state: "done", failureKind: undefined });
      expect(value(service.settle(first.runId, "attempt", execution)).state).toBe("completed");
      expect(store.usageSince(0).reduce((n, entry) => n + entry.tokens, 0)).toBe(16);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps caller cancellation terminal while accounting a late provider receipt", () => {
    const store = Store.open(":memory:"), service = new CompletionService(store, "/tmp");
    try {
      const first = value(service.submit("cancel", input)); assign(store, first.runId); value(service.claim(first.runId, "attempt"));
      expect(value(service.cancel("cancel")).state).toBe("cancelled");
      expect(value(service.settle(first.runId, "attempt", execution)).state).toBe("cancelled");
      expect(value(service.cancel("cancel")).state).toBe("cancelled");
      expect(store.run(first.runId)?.state).toBe("aborted");
      expect(store.usageSince(0).reduce((n, entry) => n + entry.tokens, 0)).toBe(16);
    } finally { store.close(); }
  });

  it("client recovers an accepted submission with the caller's same request ID", async () => {
    const store = Store.open(":memory:"), service = new CompletionService(store, "/tmp");
    try {
      let lost = true;
      const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const record = value(service.submit("network-id", JSON.parse(String(init?.body))));
        if (lost) { lost = false; throw new Error("response lost"); }
        return Response.json(record);
      });
      const client = new CompletionClient({ fetch: transport });
      expect(await client.submit("network-id", input)).toMatchObject({ ok: false, error: { code: "transport" } });
      expect(value(await client.submit("network-id", input)).state).toBe("queued");
      expect(await client.get("openapi.json")).toMatchObject({ ok: false, error: { code: "invalid-request" } });
      expect(transport).toHaveBeenCalledTimes(2);
      expect(store.runs()).toHaveLength(1);
    } finally { store.close(); }
  });

  it("generates OpenAPI from the runtime schemas without contract drift", () => {
    expect(JSON.parse(readFileSync(new URL("../docs/completions.openapi.json", import.meta.url), "utf8"))).toEqual(JSON.parse(JSON.stringify(COMPLETION_OPENAPI)));
    expect(isCompletionRecord({ requestId: "x", runId: "y", model: "luna", createdAt: 1, updatedAt: 1, ...execution })).toBe(true);
    expect(isCompletionRecord({ requestId: "x", runId: "y", model: "luna", createdAt: 1, updatedAt: 1, state: "completed" })).toBe(false);
  });
});
