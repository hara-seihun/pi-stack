import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeTimezoneProjection } from "./person-timezone.js";
import { parsePersonSettings, parseTimezone, settingsError, type PersonSettings, type PersonTimezone, type SettingsResult } from "./person-settings-contract.js";
export type { PersonSettings, PersonTimezone, SettingsResult } from "./person-settings-contract.js";
export function personSettingsPath(dataDir: string): string { return join(dataDir, "settings.json"); }
export function readPersonSettings(dataDir: string): SettingsResult<PersonSettings> {
  try { return parsePersonSettings(JSON.parse(readFileSync(personSettingsPath(dataDir), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try { readdirSync(dataDir); }
      catch { return settingsError("unavailable", "Owning settings directory is not accessible"); }
      return { ok: true, value: { version: 1, timezone: null, autoCollapse: null } };
    }
    return settingsError("unavailable", `Cannot read person settings: ${error instanceof Error ? error.message : String(error)}`);
  }
}
export function readPersonTimezone(dataDir: string): SettingsResult<PersonTimezone | null> {
  const settings = readPersonSettings(dataDir);
  return settings.ok ? { ok: true, value: settings.value.timezone } : settings;
}
export function reconcilePersonTimezoneProjection(dataDir: string, projectionFile: string): SettingsResult<PersonTimezone | null> {
  const timezone = readPersonTimezone(dataDir);
  if (!timezone.ok) return timezone;
  const published = writeTimezoneProjection(projectionFile, { version: 1, state: "ready", timezone: timezone.value });
  return published.ok ? timezone : published;
}
export function writePersonSetting(dataDir: string, id: "person.timezone" | "person.autoCollapse", value: unknown, now = new Date().toISOString()): SettingsResult<PersonSettings> {
  const projection = id === "person.timezone" ? process.env.PI_PERSON_TIMEZONE_FILE : undefined;
  if (projection && (process.env.PI_PERSON_SETTINGS_DATA ?? process.env.PI_REMOTE_DATA) !== dataDir) return settingsError("forbidden", "Timezone projection writes require the owning settings directory");
  const current = readPersonSettings(dataDir);
  if (!current.ok) return current;
  const next: PersonSettings = { ...current.value };
  if (id === "person.timezone") {
    if (value === null) next.timezone = null;
    else {
      const parsed = parseTimezone(value, now);
      if (!parsed.ok) return parsed;
      if (parsed.value.source === "client-observed" && current.value.timezone?.source === "configured") {
        if (projection) { const reconciled = reconcilePersonTimezoneProjection(dataDir, projection); if (!reconciled.ok) return reconciled; }
        return current;
      }
      next.timezone = parsed.value;
    }
  } else if (id === "person.autoCollapse") {
    if (value !== null && typeof value !== "boolean") return settingsError("invalid", "Auto-collapse must be a boolean or explicitly unset");
    next.autoCollapse = value;
  } else return settingsError("unknown-setting", "Unknown personal setting");
  if (projection) {
    const fence = writeTimezoneProjection(projection, { version: 1, state: "updating" });
    if (!fence.ok) return fence;
  }
  const path = personSettingsPath(dataDir), temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(next) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    if (projection) {
      const published = writeTimezoneProjection(projection, { version: 1, state: "ready", timezone: next.timezone });
      if (!published.ok) return published;
    }
    return { ok: true, value: next };
  } catch (error) {
    let cleanup = "";
    try { rmSync(temporary, { force: true }); }
    catch (failure) { cleanup = `; temporary file cleanup failed: ${String(failure)}`; }
    return settingsError("unavailable", `Cannot save person settings: ${error instanceof Error ? error.message : String(error)}${cleanup}`);
  }
}
