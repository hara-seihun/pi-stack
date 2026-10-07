import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { Daemon } from "../src/daemon.js";
import { Store } from "../src/store.js";
import type { LaneSpec } from "../src/domain.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const lane = (id = "lane", maxActive: number | undefined = 1, admission: "force" | "background" = "force"): LaneSpec =>
  ({ id, prompt: "work", cwd: "/tmp", profile: "sol", weight: 1, admission, maxActive });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lane-capacity-")); roots.push(root);
  const ledger = join(root, "ledger.sqlite3"), manifest = join(root, "lanes.json");
  const config = { ...loadConfig(join(root, "missing")), modelBrokerUrl: "http://127.0.0.1:2461", maxConcurrentSessions: 100, taskManifest: manifest };
  const store = Store.open(ledger);
  let daemon: any = new Daemon(store, config, undefined, undefined, { capacity: { mode: "unmanaged" } });
  return { root, store, manifest, config, get daemon() { return daemon; },
    async restart() { await daemon.threads.detach(); await daemon.schedules.close(); daemon = new Daemon(store, config, undefined, undefined, { capacity: { mode: "unmanaged" } }); return daemon; },
    async close() { await daemon.threads.detach(); await daemon.schedules.close(); store.close(); } };
}

it("validates, persists, adopts and reconciles optional positive lane ceilings atomically", () => {
  const root = mkdtempSync(join(tmpdir(), "lane-ceiling-store-")); roots.push(root);
  const path = join(root, "ledger.sqlite3");
  let store = Store.open(path);
  try {
    store.reconcileLanes([lane()]);
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      expect(() => store.reconcileLanes([lane("changed", 2), lane("invalid", value as number)]))
        .toThrow("maxActive must be a positive safe integer");
      expect(store.lanes().map(l => l.id)).toEqual(["lane"]);
    }
    store.close(); store = Store.open(path);
    expect(store.lane("lane")?.maxActive).toBe(1);
    store.reconcileLanes([lane("lane", 3)]);
    expect(store.lane("lane")?.maxActive).toBe(3);
    store.reconcileLanes([{ ...lane(), maxActive: undefined }]);
    expect(store.lane("lane")?.maxActive).toBeUndefined();
    store.db.exec("ALTER TABLE lane DROP COLUMN max_active");
    store.close(); store = Store.open(path);
    expect(store.lane("lane")?.maxActive).toBeUndefined();
    store.reconcileLanes([lane()]);
    expect(store.lane("lane")?.maxActive).toBe(1);
  } finally { store.close(); }
});

it.each(["force", "background"] as const)("keeps twenty %s lanes to one queued worker through stale readiness and restarts", async admission => {
  const f = fixture();
  writeFileSync(f.manifest, JSON.stringify({ version: 2, snapshotCommand: "unused", lanes: Array.from({ length: 20 }, (_, i) => lane(`lane:${i}`, 1, admission)) }));
  const pass = async (daemon: any, at: number) => {
    daemon.snapshotCommand = "unused";
    daemon.readinessAt = at;
    daemon.readiness = { revision: "stale-business-state", lanes: Object.fromEntries(f.store.lanes().map(l => [l.id, { ready: true }])) };
    await daemon.fillCapacity();
  };
  try {
    await f.daemon.loadManifest();
    f.daemon.threads.snapshot = () => { throw new Error("Admission cannot project history"); };
    await pass(f.daemon, 1);
    for (let at = 2; at <= 6; at++) await pass(f.daemon, at);
    expect(f.daemon.threads.runningSummary().total).toBe(20);
    expect([...f.daemon.threads.laneCustody().values()]).toEqual(Array(20).fill(1));
    // Actual quota admission refuses; accepted lane input remains queued without opening native Pi.
    const open = vi.fn(async () => { throw new Error("Must not open while model capacity is unavailable"); });
    f.daemon.threads.options.openSession = open;
    f.daemon.threads.options.admit = async () => ({ ok: false, error: { code: "unavailable", message: "No model capacity" } });
    await f.daemon.threads.start();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(open).not.toHaveBeenCalled();
    const rows = f.daemon.threads.db.prepare("SELECT id FROM thread").all() as { id: string }[];
    expect(f.daemon.threads.get(rows[0]!.id)).toMatchObject({ state: "running", pendingMessages: 1, metadata: { admissionWait: { message: "No model capacity" } } });
    await f.restart();
    await f.daemon.loadManifest();
    for (let at = 10; at <= 14; at++) await pass(f.daemon, at);
    expect(f.daemon.threads.runningSummary().total).toBe(20);
    expect(f.daemon.threads.db.prepare("SELECT count(*) n FROM thread_work WHERE status='queued'").get()).toEqual({ n: 20 });
    expect(f.daemon.status().lanes.every((l: any) => l.maxActive === 1 && l.custody === 1)).toBe(true);
  } finally { await f.close(); }
});

it("retains capacity through pending/failed native cancellation, releasing confirmed stopped queues without reviving them", async () => {
  const f = fixture();
  f.store.reconcileLanes([lane()]);
  try {
    await f.daemon.fillCapacity();
    const thread = f.daemon.threads.db.prepare("SELECT id FROM thread").get() as { id: string };
    const id = thread.id, service = f.daemon.threads, db = service.db;
    db.prepare("UPDATE thread_work SET status='dispatched',execution_id='retained' WHERE thread_id=?").run(id);
    db.prepare("INSERT INTO thread_execution(id,thread_id,work_id,settings,created_at) SELECT 'retained',thread_id,id,settings,1 FROM thread_work WHERE thread_id=?").run(id);
    db.prepare("UPDATE thread SET state='idle',metadata=json_set(metadata,'$.runnerReference',json(?)) WHERE id=?").run(JSON.stringify({ control: "control.sock", socketPath: "session.sock" }), id);
    let reject!: (error: Error) => void;
    service.options.attachSession = () => new Promise((_resolve, fail) => { reject = fail; });
    const stopping = service.control({ threadId: id, action: "stop", descendants: false });
    await new Promise(resolve => setImmediate(resolve));
    expect(service.get(id).held).toBe(true);
    await f.daemon.fillCapacity();
    expect(service.laneCustody().get("lane")).toBe(1);
    reject(new Error("Cancellation unconfirmed"));
    expect(await stopping).toMatchObject({ ok: false, error: { code: "cancellation_failed" } });
    await f.restart();
    await f.daemon.fillCapacity();
    expect(f.daemon.threads.runningSummary().total).toBe(1);
    f.daemon.threads.options.attachSession = async () => null;
    expect(await f.daemon.threads.control({ threadId: id, action: "stop", descendants: false })).toMatchObject({ ok: true });
    expect(f.daemon.threads.laneCustody().get("lane")).toBeUndefined();
    await f.daemon.fillCapacity();
    const next = (f.daemon.threads.db.prepare("SELECT id FROM thread WHERE id!=?").get(id) as { id: string }).id;
    // A confirmed Stop preserves unstarted input but releases its producer slot.
    expect(await f.daemon.threads.control({ threadId: next, action: "stop", descendants: false })).toMatchObject({ ok: true });
    expect(f.daemon.threads.get(next)).toMatchObject({ state: "idle", held: true, pendingMessages: 1 });
    await f.daemon.fillCapacity();
    expect(f.daemon.threads.laneCustody().get("lane")).toBe(1);
    expect(f.daemon.threads.get(next)).toMatchObject({ state: "idle", held: true, pendingMessages: 1 });
    expect(f.daemon.threads.db.prepare("SELECT count(*) n FROM thread").get()).toEqual({ n: 3 });
    await f.restart();
    await f.daemon.fillCapacity();
    expect(f.daemon.threads.get(next)).toMatchObject({ state: "idle", held: true, pendingMessages: 1 });
    expect(f.daemon.threads.laneCustody().get("lane")).toBe(1);
  } finally { await f.close(); }
});

it("reconciles changed limits without killing custody, preserves uncapped lanes and serializes waves", async () => {
  const f = fixture();
  let stamp = Date.now();
  const configure = async (maxActive: number | undefined) => {
    writeFileSync(f.manifest, JSON.stringify({ version: 2, lanes: [{ ...lane("lane"), maxActive }] }));
    utimesSync(f.manifest, ++stamp / 1000, stamp / 1000);
    await f.daemon.loadManifest();
  };
  try {
    await configure(1); await f.daemon.fillCapacity();
    await configure(3);
    const spawn = f.daemon.threads.spawn.bind(f.daemon.threads);
    f.daemon.threads.spawn = async (input: any) => { await new Promise(resolve => setImmediate(resolve)); return spawn(input); };
    const waves = await Promise.all(Array.from({ length: 8 }, (_, i) => f.daemon.spawnLane("lane", { requestId: `wave:${i}`, cwd: "/tmp", message: "work", settings: { model: "sol" }, metadata: { laneId: "lane", source: "direct" } })));
    expect(waves.filter(result => result.ok)).toHaveLength(2);
    expect(f.daemon.threads.laneCustody().get("lane")).toBe(3);
    await configure(1);
    await f.daemon.fillCapacity();
    expect(f.daemon.threads.laneCustody().get("lane")).toBe(3);
    await configure(undefined);
    await f.daemon.fillCapacity(); await f.daemon.fillCapacity();
    expect(f.daemon.threads.laneCustody().get("lane")).toBe(5);
    await configure(6);
    // Capacity fills during an asynchronous probe; the final admission check must see it.
    f.daemon.lanePrompt = async () => {
      await spawn({ requestId: "probe-race", cwd: "/tmp", message: "work", settings: { model: "sol" }, metadata: { laneId: "lane" } });
      return "work";
    };
    await f.daemon.fillCapacity();
    expect(f.daemon.threads.laneCustody().get("lane")).toBe(6);
  } finally { await f.close(); }
});
