import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Daemon } from "../src/daemon.js";
import { Store } from "../src/store.js";
import type { Thread } from "../src/threads/contracts.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function brokerConfig(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "broker-daemon-")); roots.push(root);
  return { root, config: { ...loadConfig(join(root, "missing.json")), modelBrokerUrl: "http://127.0.0.1:2461", maxConcurrentSessions: 1, ...extra } };
}

it("builds broker thread environments without opening or exporting local OAuth custody", async () => {
  const { config } = brokerConfig({ port: 29876 });
  const store = Store.open(":memory:");
  const daemon = new Daemon(store, config) as any;
  const thread = { admission: "force", metadata: {} } as Thread;
  try {
    expect(daemon.codexMeters).toBeUndefined();
    expect(daemon.anthropicMeters).toBeUndefined();
    expect(daemon.threadEnvironment(thread)).toMatchObject({
      PI_MODEL_BROKER_URL: "http://127.0.0.1:2461",
      PI_ORCHESTRATOR_ASSIGNED: "0",
      PI_ORCHESTRATOR_LEDGER: ":memory:",
      PI_ORCHESTRATOR_EXECUTION: "user",
      PI_THREAD_API_URL: "http://127.0.0.1:29876/v1/threads",
    });
    expect(daemon.threadEnvironment(thread).PI_ORCHESTRATOR_AUTH).toBeUndefined();
  } finally {
    await daemon.threads.close();
    await daemon.schedules.close();
    store.close();
  }
});

it("rejects root-repair lane manifests before adding them to broker state", async () => {
  const { root, config } = brokerConfig();
  const manifest = join(root, "lanes.json");
  writeFileSync(manifest, JSON.stringify({ version: 2, lanes: [{
    id: "repair", prompt: "repair", cwd: root, profile: "astra", weight: 1,
    repair: { readinessCommand: "true" },
  }] }));
  const store = Store.open(":memory:");
  const daemon = new Daemon(store, { ...config, taskManifest: manifest }) as any;
  try {
    await expect(daemon.loadManifest()).rejects.toThrow("Root-repair lanes are unavailable");
    expect(store.lanes()).toEqual([]);
  } finally {
    await daemon.threads.close();
    await daemon.schedules.close();
    store.close();
  }
});
