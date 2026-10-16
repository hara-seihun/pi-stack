import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Daemon } from "../src/daemon.js";
import { Fleet } from "../src/fleet.js";
import { assign } from "../src/policy.js";
import { Store } from "../src/store.js";
import type { Thread } from "../src/threads/contracts.js";

it.each(["background", "force", "live"] as const)("account admission %s retains quota and explicit pause gates", admission => {
  const store = Store.open(":memory:");
  const config = loadConfig("/missing");
  store.upsertAccount({ id: "a", provider: "openai-codex", concurrency: 1 });
  try {
    for (let i = 0; i < 48; i++) {
      expect(assign(store, "sol", admission, config).assignment?.accountId).toBe("a");
      store.createLease(`worker:${i}`, "a", "fleet");
    }
    expect(assign(store, "sol", "background", config).assignment?.accountId).toBe("a");
    for (const [key, reason] of [["launches", "emergency halt"], ["ordinary-launches", "ordinary work paused"]]) {
      store.setControl(key!, "paused");
      expect(assign(store, "sol", admission, config).refusals[0]?.reason).toBe(reason);
      store.setControl(key!, "enabled");
    }
    store.setCooldown("a", Date.now() + 60_000);
    expect(assign(store, "sol", admission, config).refusals[0]?.reason).toContain("account cooling down");
  } finally { store.close(); }
});

it.each(["force", "live"] as const)("broker account admission for %s never owns the global agent slot budget", async admission => {
  const store = Store.open(":memory:");
  const fleet = new Fleet(store, { ...loadConfig("/missing"), modelBrokerUrl: "http://127.0.0.1:2461" });
  const settings = { model: "openai-codex/gpt-6.1-sol", thinkingLevel: "medium", speed: "priority" } as const;
  const thread = { settings, admission } as Thread;
  const releases: (() => void | Promise<void>)[] = [];
  try {
    for (let i = 0; i < 8; i++) {
      const admitted = await fleet.admit({ ...thread, id: `worker:${i}` }, settings, false, `execution:${i}`);
      expect(admitted.ok).toBe(true);
      if (admitted.ok) releases.push(admitted.value.release);
    }
    const background = await fleet.admit({ ...thread, id: "background", admission: "background" }, settings, false, "background");
    expect(background.ok).toBe(true);
    if (background.ok) releases.push(background.value.release);
    const child = await fleet.admit({ ...thread, id: "child", parentId: "parent", admission: "background" }, settings, false, "child");
    expect(child.ok).toBe(true);
    if (child.ok) releases.push(child.value.release);
  } finally { for (const release of releases) await release(); store.close(); }
});

it("queues every ready lane in one bounded readiness pass; execution admission owns capacity", async () => {
  const store = Store.open(":memory:");
  const daemon = new Daemon(store, { ...loadConfig("/missing"), modelBrokerUrl: "http://127.0.0.1:2461" }) as any;
  store.reconcileLanes(Array.from({ length: 8 }, (_, i) => ({ id: `lane:${i}`, prompt: "work", cwd: "/tmp", profile: "sol", weight: 1 })));
  const spawned: string[] = [];
  daemon.threads.snapshot = () => { throw new Error("Scheduling must not project historical threads"); };
  daemon.threads.runningSummary = () => ({ total: 1, lanes: new Map(), repairOwner: undefined });
  daemon.threads.spawn = async (input: any) => { spawned.push(input.metadata.laneId); return { ok: true, value: { id: input.metadata.laneId } }; };
  try {
    await daemon.fillCapacity();
    expect(new Set(spawned).size).toBe(8);
    expect(spawned.length).toBe(8);
  } finally { await daemon.threads.close(); await daemon.schedules.close(); store.close(); }
});
