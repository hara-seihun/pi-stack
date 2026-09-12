import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadConfig, resolveCore } from "../src/config.js";
import { Store } from "../src/store.js";
import { Fleet } from "../src/fleet.js";
import { catalogModel } from "../src/catalog.js";
import { Daemon } from "../src/daemon.js";
import { Readable } from "node:stream";

it("resolves run/lane, profile and default core choices without changing model defaults", () => {
  const config = { core: "pi" as const, profileCores: { astra: "codex" as const } };
  expect(resolveCore({}, "astra")).toBe("pi");
  expect(resolveCore(config, "astra")).toBe("codex");
  expect(resolveCore(config, "astra", "pi")).toBe("pi");
  expect(resolveCore({ core: "codex" }, "sol")).toBe("codex");
  const root = mkdtempSync(join(tmpdir(), "core-config-"));
  try {
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify(config));
    expect(loadConfig(path).profiles.astra?.[0]).toMatchObject({ model: catalogModel("astra")!.model, thinking: "xhigh" });
    writeFileSync(path, '{"profileCores":{"astra":"other"}}');
    expect(() => loadConfig(path)).toThrow("unknown agent core");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("pins core custody across lane edits, ledger reopening, assignment and recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "core-custody-")), path = join(root, "ledger.sqlite3");
  let store = Store.open(path);
  try {
    store.upsertAccount({ id: "account", provider: "openai-codex", concurrency: 2 });
    const lane = { id: "lane", prompt: "work", cwd: "/app", profile: "astra", weight: 1, core: "codex" as const };
    store.reconcileLanes([lane]);
    const [id] = store.createRuns({ count: 1, source: "lane", sourceId: lane.id, prompt: lane.prompt, cwd: lane.cwd, profile: lane.profile, budget: "background", core: store.lane(lane.id)!.core });
    const before = store.run(id!)!;
    expect(before).toMatchObject({ core: "codex", coreStateDir: join(root, "runs", id!), childrenOwner: "core" });
    store.reconcileLanes([{ ...lane, core: "pi" }]);
    store.assignRun(id!, { ...catalogModel("astra")!, accountId: "account", releasePath: "/immutable/release", unit: "unit" });
    store.updateRun(id!, { state: "running", nativeSessionId: "native", portableSessionFile: "/durable/portable.jsonl" });
    store.close(); store = Store.open(path);
    expect(store.resumeAssignedRun(id!)).toBe(true);
    expect(store.run(id!)).toMatchObject({ core: before.core, coreStateDir: before.coreStateDir, budget: before.budget, childrenOwner: "core", state: "starting", nativeSessionId: "native", portableSessionFile: "/durable/portable.jsonl", releasePath: "/immutable/release", model: catalogModel("astra")!.model, thinking: "xhigh" });
    expect(store.activeLeases()).toHaveLength(1);
    expect(store.lane(lane.id)?.core).toBe("pi");
    store.updateRun(id!, { state: "running" });
    expect(new Fleet(store).dispatch(id!, { requestId: "child", model: "luna", task: "work" })).toEqual({ ok: false, error: "not-coordinator" });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

it("routes API core overrides and records usage receipts once", async () => {
  const store = Store.open(":memory:");
  const daemon = new Daemon(store, { ...loadConfig("/nonexistent-config"), profileCores: { astra: "codex" } });
  (daemon as any).reconcile = async () => {};
  const request = async (url: string, input: unknown) => {
    let status = 0, value: any;
    const req = Object.assign(Readable.from([JSON.stringify(input)]), { url, method: "POST" });
    await (daemon as any).request(req, { writeHead: (code: number) => { status = code; }, end: (body: string) => { value = JSON.parse(body); } });
    return { status, value };
  };
  try {
    expect((await request("/v1/run", { prompt: "work", profile: "astra", core: "unknown" })).status).toBe(400);
    expect((await request("/v1/run/isolated", { prompt: "work", cwd: "/app", profile: "astra", context: { tools: [] } })).status).toBe(422);
    const selected = await request("/v1/run", { prompt: "work", profile: "astra" });
    expect(store.run(selected.value.runIds[0])?.core).toBe("codex");
    const override = await request("/v1/run", { prompt: "work", profile: "astra", core: "pi" });
    const id = override.value.runIds[0];
    expect(store.run(id)?.core).toBe("pi");
    store.upsertAccount({ id: "account", provider: "openai-codex", concurrency: 1 });
    store.assignRun(id, { ...catalogModel("astra")!, accountId: "account", releasePath: "/release", unit: "unit" });
    const usage = { receiptId: "a".repeat(64), accountId: "account", model: catalogModel("astra")!.model, usage: { input: 12, output: 5 } };
    expect((await request(`/internal/runs/${id}/usage`, usage)).status).toBe(200);
    expect((await request(`/internal/runs/${id}/usage`, usage)).status).toBe(200);
    expect(store.usageSince(0).reduce((sum, row) => sum + row.tokens, 0)).toBe(17);
  } finally { store.close(); }
});

it("rejects unsupported isolated Codex runs atomically and rolls back core custody", () => {
  const store = Store.open(":memory:");
  const input = { count: 1, source: "direct" as const, prompt: "work", cwd: "/app", profile: "astra", budget: "force" as const, core: "codex" as const };
  try {
    expect(() => store.createRuns({ ...input, context: { tools: ["app_tool"], extensions: ["/app/tool.ts"] } })).toThrow("does not support isolated");
    expect(() => store.transaction(() => { store.createRuns(input); throw new Error("rollback"); })).toThrow("rollback");
    expect(store.runs()).toEqual([]);
    expect(store.db.prepare("SELECT key FROM control WHERE key LIKE 'run-core:%'").all()).toEqual([]);
  } finally { store.close(); }
});
