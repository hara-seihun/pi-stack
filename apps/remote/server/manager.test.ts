import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { SpawnThread, Thread, ThreadApi } from "pi-orchestrator/api";
import { Manager, MANAGER_HEARTBEAT_MS, managerDestination, managerSettings, parseManagerPatch } from "./manager";
import { configuredThreadDestinations, defaultThreadDestinations } from "./thread-model-defaults";

function fixture() {
  const db = new Database(":memory:");
  const spawned: SpawnThread[] = [];
  const wakes: Parameters<ThreadApi["wakeSchedule"]>[0][] = [];
  let rejectWake = false;
  const api: Pick<ThreadApi, "spawn" | "wakeSchedule"> = {
    async spawn(input) { spawned.push(input); return { ok: true, value: { id: input.id } as Thread }; },
    async wakeSchedule(input) {
      wakes.push(input);
      return rejectWake ? { ok: false, error: { code: "unavailable", message: "owner suspended" } } : { ok: true, value: null };
    },
  };
  const settings = managerSettings(undefined);
  if (!settings.ok) throw new Error(settings.error.message);
  const make = () => new Manager(db, api, () => ({ ok: true, value: { cwd: "/example/person", metadata: { profileId: "personal", contextFiles: ["PROFILE.md"] } } }), settings.value, () => {});
  return { db, make, spawned, wakes, rejectWake: (value: boolean) => { rejectWake = value; } };
}

describe("person manager view", () => {
  test("creation is lazy, serialized, restart-safe and does not reset a cancelled heartbeat", async () => {
    const f = fixture();
    let manager = f.make();
    expect(manager.snapshot()).toEqual({ view: "classic", managerThreadId: null, hintSeen: false });
    expect(f.spawned).toHaveLength(0);
    await manager.update({ view: "classic" });
    expect(f.spawned).toHaveLength(0);
    const results = await Promise.all([manager.update({ view: "mono" }), manager.update({ view: "mono", hintSeen: true })]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]!.message).toBeUndefined();
    expect(f.spawned[0]!.metadata).toMatchObject({ manager: true, foreground: true, profileId: "personal", contextFiles: ["PROFILE.md"] });
    expect(f.spawned[0]!.settings).toEqual({ model: "anthropic/claude-opus-5-5", thinkingLevel: "high", speed: "standard" });
    expect(f.wakes).toHaveLength(1);
    expect(f.wakes[0]).toMatchObject({ action: "set", cadenceMs: MANAGER_HEARTBEAT_MS });
    const id = manager.snapshot().managerThreadId;
    manager = f.make();
    await manager.update({ view: "classic" });
    await manager.update({ view: "mono", hintSeen: false });
    expect(manager.snapshot()).toEqual({ view: "mono", managerThreadId: id, hintSeen: true });
    expect(f.spawned).toHaveLength(1);
    expect(f.wakes).toHaveLength(1);
    f.db.close();
  });

  test("interrupted provisioning retries the same identity before committing mono", async () => {
    const f = fixture();
    f.rejectWake(true);
    let manager = f.make();
    expect((await manager.update({ view: "mono" })).ok).toBe(false);
    expect(manager.snapshot().view).toBe("classic");
    const id = manager.snapshot().managerThreadId;
    manager = f.make();
    f.rejectWake(false);
    expect((await manager.update({ view: "mono" })).ok).toBe(true);
    expect(f.spawned[1]!.id).toBe(id);
    expect(f.spawned[1]!.requestId).toBe(f.spawned[0]!.requestId);
    expect(f.wakes[1]!.requestId).toBe(f.wakes[0]!.requestId);
    f.db.close();
  });

  test("configuration rejects unknown or restricted destinations and malformed context names", () => {
    const destinations = defaultThreadDestinations("private");
    expect(managerDestination(destinations, undefined)).toMatchObject({ ok: true, value: { id: "personal" } });
    expect(managerDestination(destinations, "raw").ok).toBe(false);
    expect(managerDestination(destinations, "missing").ok).toBe(false);
    expect(managerDestination([], undefined).ok).toBe(false);
    expect(() => configuredThreadDestinations(destinations.map(destination => ({ ...destination, managerContextFiles: ["../PROFILE.md"] })), [])).toThrow("managerContextFiles");
    expect(managerSettings("no-such-model").ok).toBe(false);
    expect(parseManagerPatch({ view: "mono", hintSeen: "yes" }).ok).toBe(false);
    expect(parseManagerPatch({ view: "unknown" }).ok).toBe(false);
    expect(parseManagerPatch({ view: "classic", managerThreadId: "injected" }).ok).toBe(false);
  });
});
