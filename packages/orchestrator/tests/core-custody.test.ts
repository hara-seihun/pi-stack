import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { Fleet } from "../src/fleet.js";
import { catalogModel } from "../src/catalog.js";
import { Daemon } from "../src/daemon.js";
import { Readable } from "node:stream";

it("keeps Anthropic runs queued for account admission", async () => {
  const store = Store.open(":memory:");
  const daemon = new Daemon(store, loadConfig("/nonexistent-config"));
  try {
    const [id] = store.createRuns({ count: 1, source: "direct", prompt: "work", cwd: "/app", profile: "opus", budget: "force" });
    expect(await (daemon as any).launch(store.run(id!))).toBe(false);
    expect(store.run(id!)?.state).toBe("queued");
  } finally { store.close(); }
});

it("pins Pi custody across lane edits, ledger reopening, assignment and recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "core-custody-")), path = join(root, "ledger.sqlite3");
  let store = Store.open(path);
  try {
    store.upsertAccount({ id: "account", provider: "openai-codex", concurrency: 2 });
    const lane = { id: "lane", prompt: "work", cwd: "/app", profile: "astra", weight: 1 };
    store.reconcileLanes([lane]);
    const [id] = store.createRuns({ count: 1, source: "lane", sourceId: lane.id, prompt: lane.prompt, cwd: lane.cwd, profile: lane.profile, budget: "background" });
    const before = store.run(id!)!;
    expect(before).toMatchObject({ core: "pi", coreStateDir: join(root, "runs", id!), childrenOwner: "core" });
    store.reconcileLanes([{ ...lane, profile: "sol" }]);
    store.assignRun(id!, { ...catalogModel("astra")!, accountId: "account", releasePath: "/immutable/release", unit: "unit" });
    store.updateRun(id!, { state: "running", nativeSessionId: "native", portableSessionFile: "/durable/portable.jsonl" });
    store.close(); store = Store.open(path);
    expect(store.resumeAssignedRun(id!)).toBe(true);
    expect(store.run(id!)).toMatchObject({ core: "pi", coreStateDir: before.coreStateDir, budget: before.budget, childrenOwner: "core", state: "starting", nativeSessionId: "native", portableSessionFile: "/durable/portable.jsonl", releasePath: "/immutable/release", model: catalogModel("astra")!.model, thinking: "xhigh" });
    expect(store.activeLeases()).toHaveLength(1);
    store.updateRun(id!, { state: "running" });
    expect(new Fleet(store).dispatch(id!, { requestId: "child", model: "luna", task: "work" })).toEqual({ ok: false, error: "not-coordinator" });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

it("records usage receipts once for Pi runs", async () => {
  const store = Store.open(":memory:");
  const daemon = new Daemon(store, loadConfig("/nonexistent-config"));
  (daemon as any).reconcile = async () => {};
  const request = async (url: string, input: unknown) => {
    let status = 0, value: any;
    const req = Object.assign(Readable.from([JSON.stringify(input)]), { url, method: "POST" });
    await (daemon as any).request(req, { writeHead: (code: number) => { status = code; }, end: (body: string) => { value = JSON.parse(body); } });
    return { status, value };
  };
  try {
    const selected = await request("/v1/run", { prompt: "work", profile: "astra" });
    const id = selected.value.runIds[0];
    expect(store.run(id)?.core).toBe("pi");
    store.upsertAccount({ id: "account", provider: "openai-codex", concurrency: 1 });
    store.assignRun(id, { ...catalogModel("astra")!, accountId: "account", releasePath: "/release", unit: "unit" });
    const usage = { receiptId: "a".repeat(64), accountId: "account", model: catalogModel("astra")!.model, usage: { input: 12, output: 5 } };
    expect((await request(`/internal/runs/${id}/usage`, usage)).status).toBe(200);
    expect((await request(`/internal/runs/${id}/usage`, usage)).status).toBe(200);
    expect(store.usageSince(0).reduce((sum, row) => sum + row.tokens, 0)).toBe(17);
  } finally { store.close(); }
});

it("rolls back run creation and Pi custody together", () => {
  const store = Store.open(":memory:");
  const input = { count: 1, source: "direct" as const, prompt: "work", cwd: "/app", profile: "astra", budget: "force" as const };
  try {
    expect(() => store.transaction(() => { store.createRuns(input); throw new Error("rollback"); })).toThrow("rollback");
    expect(store.runs()).toEqual([]);
    expect(store.db.prepare("SELECT key FROM control WHERE key LIKE 'run-core:%'").all()).toEqual([]);
  } finally { store.close(); }
});
