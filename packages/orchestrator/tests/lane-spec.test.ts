import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Daemon } from "../src/daemon.js";
import { Store } from "../src/store.js";
import type { SettingsOverrides, Thread } from "../src/threads/contracts.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("defaults lanes to forced admission and retains explicit background pacing", () => {
  const store = Store.open(":memory:");
  try {
    store.reconcileLanes([
      { id: "forced", cwd: "/tmp", prompt: "work", profile: "astra", weight: 1 },
      { id: "paced", cwd: "/tmp", prompt: "work", profile: "sol", weight: 2, admission: "background" },
    ]);
    expect(store.lane("forced")?.admission).toBe("force");
    expect(store.lane("paced")?.admission).toBe("background");
    expect(() => store.reconcileLanes([{ id: "bad", cwd: "/tmp", prompt: "work", profile: "astra", weight: 1, admission: "urgent" as never }])).toThrow("admission must be force or background");
  } finally { store.close(); }
});

it("keeps a declared lane thinking level in the ledger and rejects an invalid one", () => {
  const root = mkdtempSync(join(tmpdir(), "lane-spec-")); roots.push(root);
  const ledger = join(root, "ledger.sqlite3");
  const store = Store.open(ledger);
  store.reconcileLanes([
    { id: "bonsai", cwd: "/tmp", prompt: "optimize", profile: "sol", weight: 1, thinkingLevel: "max" },
    { id: "plain", cwd: "/tmp", prompt: "work", profile: "astra", weight: 1 },
  ]);
  expect(() => store.reconcileLanes([{ id: "bonsai", cwd: "/tmp", prompt: "optimize", profile: "sol", weight: 1, thinkingLevel: "maximum" as never }]))
    .toThrow("thinkingLevel must be one of off, minimal, low, medium, high, xhigh, max");
  store.close();

  const reopened = Store.open(ledger);
  try {
    expect(reopened.lane("bonsai")?.thinkingLevel).toBe("max");
    expect(reopened.lane("plain")?.thinkingLevel).toBeUndefined();
  } finally { reopened.close(); }
});

it("gives every lane worker the declared thinking level, before and after a daemon restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "lane-spec-daemon-")); roots.push(root);
  const ledger = join(root, "ledger.sqlite3"), manifest = join(root, "lanes.json");
  writeFileSync(manifest, JSON.stringify({ version: 2, lanes: [
    { id: "bonsai", prompt: "optimize", cwd: root, profile: "sol", weight: 1, thinkingLevel: "max" },
    { id: "plain", prompt: "work", cwd: root, profile: "astra", weight: 1 },
  ] }));
  const config = { ...loadConfig(join(root, "missing.json")), modelBrokerUrl: "http://127.0.0.1:2461", maxConcurrentSessions: 3 };
  const store = Store.open(ledger);

  async function admit(daemon: any): Promise<{ lane: string; settings: SettingsOverrides }[]> {
    const spawned: { lane: string; settings: SettingsOverrides }[] = [];
    daemon.threads.spawn = async (input: any) => {
      spawned.push({ lane: input.metadata.laneId, settings: input.settings });
      return { ok: true, value: { id: `thread-${spawned.length}` } };
    };
    daemon.threads.snapshot = () => spawned.map((entry, index) => ({ id: `thread-${index}`, state: "running", metadata: { laneId: entry.lane } }) as unknown as Thread);
    await daemon.fillCapacity();
    return spawned;
  }

  const daemon = new Daemon(store, { ...config, taskManifest: manifest }) as any;
  try {
    await daemon.loadManifest();
    const spawned = await admit(daemon);
    expect(spawned.map(entry => entry.lane)).toEqual(["bonsai", "plain", "bonsai"]);
    expect(spawned.filter(entry => entry.lane === "bonsai").map(entry => entry.settings)).toEqual([
      { model: "openai-codex/gpt-6-sol", thinkingLevel: "max" },
      { model: "openai-codex/gpt-6-sol", thinkingLevel: "max" },
    ]);
    expect(spawned.find(entry => entry.lane === "plain")?.settings).toEqual({ model: "openai-codex/gpt-6-astra" });
  } finally {
    await daemon.threads.close();
    await daemon.schedules.close();
  }

  const restarted = new Daemon(store, config) as any;
  try {
    expect((await admit(restarted))[0]?.settings).toEqual({ model: "openai-codex/gpt-6-sol", thinkingLevel: "max" });
  } finally {
    await restarted.threads.close();
    await restarted.schedules.close();
    store.close();
  }
});
