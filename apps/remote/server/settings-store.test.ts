import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPersonTimezone, writePersonSetting } from "../../../packages/orchestrator/src/person-settings";
import { SettingsService } from "./settings-store";
import { modelAvailabilityDefinition } from "../shared/settings";
const directories: string[] = [];
const directory = () => { const value = mkdtempSync(join(tmpdir(), "person-settings-")); directories.push(value); return value; };
afterEach(() => { for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true }); });
test("timezone is unset until observed; configured provenance defeats device observations", () => {
  const data = directory();
  expect(readPersonTimezone(data)).toEqual({ ok: true, value: null });
  expect(writePersonSetting(data, "person.timezone", { zone: "America/New_York", source: "client-observed" }, "2026-10-08T12:00:00Z").ok).toBe(true);
  expect(writePersonSetting(data, "person.timezone", { zone: "Europe/London", source: "configured" }, "2026-10-08T13:00:00Z").ok).toBe(true);
  writePersonSetting(data, "person.timezone", { zone: "Asia/Tokyo", source: "client-observed" }, "2026-10-08T14:00:00Z");
  expect(readPersonTimezone(data)).toEqual({ ok: true, value: { zone: "Europe/London", source: "configured", observedAt: "2026-10-08T13:00:00Z" } });
  expect(statSync(join(data, "settings.json")).mode & 0o777).toBe(0o600);
});
test("invalid timezone and corrupt settings produce errors without invented values or overwrite", () => {
  const data = directory();
  expect(writePersonSetting(data, "person.timezone", { zone: "Not/AZone", source: "configured" }).ok).toBe(false);
  expect(writePersonSetting(data, "person.timezone", { zone: "+01:00", source: "configured" }).ok).toBe(false);
  writeFileSync(join(data, "settings.json"), "broken", { mode: 0o600 });
  expect(readPersonTimezone(data).ok).toBe(false);
  expect(writePersonSetting(data, "person.autoCollapse", true).ok).toBe(false);
  expect(readFileSync(join(data, "settings.json"), "utf8")).toBe("broken");
});
test("ordinary accounts cannot enumerate system definitions or call system owning adapters", async () => {
  let writes = 0;
  const adapter = { definition: modelAvailabilityDefinition("sol", "Sol", "/host-only"), read: async () => ({ ok: true as const, value: true }), write: async () => { writes += 1; return { ok: true as const, value: false }; } };
  const service = new SettingsService(directory(), false, () => [adapter]);
  expect((await service.snapshot()).entries.every(entry => entry.definition.scope === "person")).toBe(true);
  expect(await service.update("model.available:sol", { value: false })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(await service.update("system.host", { value: "changed" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(writes).toBe(0);
});
test("administrator writes owning adapters once; unknown/arbitrary configuration never writes", async () => {
  let value = true, writes = 0;
  const service = new SettingsService(directory(), true, () => [{ definition: modelAvailabilityDefinition("sol", "Sol", "/host-only"), read: async () => ({ ok: true, value }), write: async next => { value = next as boolean; writes += 1; return { ok: true, value }; } }]);
  expect(await service.update("model.available:sol", { value: false })).toMatchObject({ ok: true, value: { value: { state: "set", value: false } } });
  expect(await service.update("system.host", { value: "changed" })).toMatchObject({ ok: false, error: { code: "owner-managed" } });
  expect(await service.update("arbitrary.secret", { value: "changed" })).toMatchObject({ ok: false, error: { code: "unknown-setting" } });
  expect(await service.update("model.available:sol", { value: "false" })).toMatchObject({ ok: false, error: { code: "invalid" } });
  expect(writes).toBe(1);
});
