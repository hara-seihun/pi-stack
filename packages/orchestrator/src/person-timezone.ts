import { constants, closeSync, fchmodSync, fstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseTimezone, settingsError, settingsObject, type PersonTimezone, type SettingsResult } from "./person-settings-contract.js";
export type { PersonTimezone, SettingsResult } from "./person-settings-contract.js";
export type TimezoneProjection = { version: 1; state: "ready"; timezone: PersonTimezone | null } | { version: 1; state: "updating" };

export function parseTimezoneMetadata(value: unknown): SettingsResult<PersonTimezone | null> {
  if (value === null) return { ok: true, value: null };
  if (!settingsObject(value) || typeof value.observedAt !== "string" || Object.keys(value).some(key => !["zone", "source", "observedAt"].includes(key))) return settingsError("invalid", "Invalid timezone provenance");
  return parseTimezone(value, value.observedAt);
}

export function readTimezoneProjection(path: string): SettingsResult<PersonTimezone | null> {
  if (!isAbsolute(path)) return settingsError("invalid", "Timezone projection path must be absolute");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) return settingsError("invalid", "Invalid timezone projection file");
    const contents = readFileSync(fd, "utf8");
    let projection: unknown;
    try { projection = JSON.parse(contents); }
    catch { return settingsError("invalid", "Invalid timezone projection JSON"); }
    if (!settingsObject(projection) || projection.version !== 1) return settingsError("invalid", "Invalid timezone projection schema");
    if (projection.state === "updating" && Object.keys(projection).every(key => ["version", "state"].includes(key))) return settingsError("unavailable", "Timezone authority is updating; retry after owner reconciliation");
    if (projection.state !== "ready" || !Object.hasOwn(projection, "timezone") || Object.keys(projection).some(key => !["version", "state", "timezone"].includes(key))) return settingsError("invalid", "Invalid timezone projection state");
    return parseTimezoneMetadata(projection.timezone);
  } catch (error) { return settingsError("unavailable", `Cannot read declared timezone projection: ${error instanceof Error ? error.message : String(error)}`); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function writeTimezoneProjection(path: string, projection: TimezoneProjection): SettingsResult<null> {
  if (!isAbsolute(path)) return settingsError("invalid", "Timezone projection path must be absolute");
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o640);
    try {
      writeFileSync(fd, JSON.stringify(projection) + "\n");
      fchmodSync(fd, 0o640);
    } finally { closeSync(fd); }
    renameSync(temporary, path);
    return { ok: true, value: null };
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { return settingsError("unavailable", "Timezone projection write and temporary-file cleanup failed"); }
    return settingsError("unavailable", `Cannot publish timezone projection: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function deliveryTimezone(env: NodeJS.ProcessEnv): SettingsResult<PersonTimezone | null> {
  if (env.PI_MODEL_DELIVERY_TIMEZONE !== undefined) {
    try { return parseTimezoneMetadata(JSON.parse(env.PI_MODEL_DELIVERY_TIMEZONE)); }
    catch { return settingsError("invalid", "Invalid authenticated delivery timezone metadata"); }
  }
  if (env.PI_PERSON_TIMEZONE_FILE !== undefined) return readTimezoneProjection(env.PI_PERSON_TIMEZONE_FILE);
  return settingsError("unavailable", "No authoritative timezone projection or authenticated timezone metadata was declared");
}
