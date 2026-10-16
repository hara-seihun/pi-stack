import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadService } from "../src/threads/service.js";
import { resolveSpawnSettings } from "../src/threads/settings.js";
import { configuredPersonSpawnModel } from "../src/threads/person-spawn-model.js";
import type { Thread } from "../src/threads/contracts.js";
const SOL = "openai-codex/gpt-6.1-sol", ASTRA = "openai-codex/gpt-6-astra", LUNA = "openai-codex/gpt-6-luna";
const roots: string[] = [], owners: ThreadService[] = [];
afterEach(async () => { for (const owner of owners.splice(0)) await owner.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const path = mkdtempSync(join(tmpdir(), "person-spawn-")); roots.push(path); return path; }
function owner(path: string, spawnDefaultModel?: () => string | undefined) {
  const service = new ThreadService({ databasePath: join(path, "threads.sqlite"), sessionsDir: path, spawnDefaultModel,
    capacity: { mode: "unmanaged" }, openSession: async () => { throw Error("No model in routing fixture"); },
    admitNewThread: settings => settings.model === ASTRA ? { ok: false, error: { code: "invalid_request", message: "Astra disabled" } } : { ok: true, value: undefined } });
  vi.spyOn(service as any, "wake").mockImplementation(() => {}); owners.push(service); return service;
}
it("owner registry is person-scoped, dynamic, rooms-excluded and fails closed", () => {
  const dir = root(), env = { PI_REMOTE_PERSONS_DIR: dir, PI_THREAD_DEFAULT_MODEL: "luna" };
  const save = (person: string, model?: unknown) => writeFileSync(join(dir, person+".json"), JSON.stringify({ version: 1, user: person, environment: model === undefined ? {} : { PI_THREAD_DEFAULT_MODEL: model } }));
  save("martine", SOL); save("alice");
  expect(configuredPersonSpawnModel(env, "martine")).toBe(SOL);
  expect(configuredPersonSpawnModel(env, "alice")).toBeUndefined(); // no stale ambient setting
  expect(configuredPersonSpawnModel({ ...env, PI_REMOTE_ROOMS_RUNTIME: "1" }, "martine")).toBeUndefined();
  save("martine", "opus"); expect(configuredPersonSpawnModel(env, "martine")).toBe("opus");
  save("martine", false); expect(() => configuredPersonSpawnModel(env, "martine")).toThrow("default model");
  writeFileSync(join(dir, "martine.json"), "{"); expect(() => configuredPersonSpawnModel(env, "martine")).toThrow("unavailable");
  expect(() => configuredPersonSpawnModel(env, "../alice")).toThrow();
  expect(configuredPersonSpawnModel(env, "unregistered")).toBe("luna");
});
it("implicit legacy fallbacks use the owner model; permitted live Luna and explicit settings remain intact", async () => {
  const path = root(), martine = owner(path, () => SOL), other = owner(root());
  expect(await martine.spawn({ requestId: "parentless", id: "parentless", cwd: path })).toMatchObject({ ok: true, value: { settings: { model: SOL, thinkingLevel: "high", speed: "standard" } } });
  expect(await other.spawn({ requestId: "parentless", cwd: path })).toMatchObject({ ok: false, error: { message: "Astra disabled" } });
  const live = await martine.spawn({ requestId: "live", id: "live", cwd: path, metadata: { mode: "live" } });
  expect(live).toMatchObject({ ok: true, value: { settings: { model: SOL, thinkingLevel: "low", speed: "priority" } } });
  expect(await martine.spawn({ requestId: "live-worker", parentId: "live", cwd: path })).toMatchObject({ ok: true, value: { settings: { model: LUNA, thinkingLevel: "medium", speed: "priority" } } });
  expect(await martine.spawn({ requestId: "ordinary-worker", parentId: "parentless", cwd: path })).toMatchObject({ ok: true, value: { settings: { model: SOL, thinkingLevel: "high", speed: "standard" } } });
  const parent = live.ok ? live.value : null;
  expect(resolveSpawnSettings(undefined, parent)).toMatchObject({ ok: true, value: { model: LUNA, thinkingLevel: "medium", speed: "priority" } });
  expect(await martine.spawn({ requestId: "explicit-worker", parentId: "live", cwd: path, settings: { model: "luna", thinkingLevel: "low", speed: "standard" } })).toMatchObject({ ok: true, value: { settings: { model: LUNA, thinkingLevel: "low", speed: "standard" } } });
  expect(await martine.spawn({ requestId: "bad", cwd: path, settings: { model: "not-a-model" } })).toMatchObject({ ok: false });
  expect(resolveSpawnSettings({ extra: true } as any, null, undefined, SOL)).toMatchObject({ ok: false });
  expect(resolveSpawnSettings([] as any, null, undefined, SOL)).toMatchObject({ ok: false });
});
it("accepted receipts and running work retain settings/custody after the owner default changes", async () => {
  const path = root(); let model = "luna", calls = 0;
  const service = owner(path, () => { calls++; return model; });
  const request = { id: "existing", requestId: "existing", cwd: path, message: "existing accepted work" };
  const accepted = await service.spawn(request); expect(accepted).toMatchObject({ ok: true, value: { state: "running", settings: { model: LUNA } } });
  const pending = service.pending("existing"); model = SOL;
  expect(await service.spawn(request)).toEqual(accepted); expect(calls).toBe(1);
  expect(service.pending("existing")).toEqual(pending); expect(service.get("existing")?.settings.model).toBe(LUNA);
  expect(await service.spawn({ requestId: "new", cwd: path })).toMatchObject({ ok: true, value: { settings: { model: SOL } } });
  // Explicit selection is independent even if reading the owner's implicit default is unavailable.
  const broken = owner(root(), () => { throw Error("registry unavailable"); });
  expect(await broken.spawn({ requestId: "explicit", cwd: path, settings: { model: "luna" } })).toMatchObject({ ok: true, value: { settings: { model: LUNA } } });
  expect(await broken.spawn({ requestId: "implicit", cwd: path })).toMatchObject({ ok: false });
});
