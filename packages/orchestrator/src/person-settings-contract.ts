export type SettingsErrorCode = "invalid" | "unavailable" | "forbidden" | "unknown-setting" | "owner-managed";
export type SettingsResult<T> = { ok: true; value: T } | { ok: false; error: { code: SettingsErrorCode; message: string } };
export type PersonTimezone = { zone: string; source: "configured" | "client-observed"; observedAt: string };
export type PersonSettings = { version: 1; timezone: PersonTimezone | null; autoCollapse: boolean | null };
export function settingsError(code: SettingsErrorCode, message: string): SettingsResult<never> { return { ok: false, error: { code, message } }; }
export function settingsObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function parseTimezone(value: unknown, observedAt: string): SettingsResult<PersonTimezone> {
  if (!settingsObject(value) || typeof value.zone !== "string" || !value.zone.trim() || /^[+-]/.test(value.zone) || (value.source !== "configured" && value.source !== "client-observed")) return settingsError("invalid", "Choose an IANA timezone and its configured or client-observed provenance");
  if (!Number.isFinite(Date.parse(observedAt))) return settingsError("invalid", "Timezone observation needs a valid timestamp");
  try {
    const zone = new Intl.DateTimeFormat("en", { timeZone: value.zone }).resolvedOptions().timeZone;
    return { ok: true, value: { zone, source: value.source, observedAt } };
  } catch { return settingsError("invalid", "Unknown IANA timezone"); }
}
export function parsePersonSettings(value: unknown): SettingsResult<PersonSettings> {
  if (!settingsObject(value) || value.version !== 1 || !Object.hasOwn(value, "timezone") || !Object.hasOwn(value, "autoCollapse") || Object.keys(value).some(key => !["version", "timezone", "autoCollapse"].includes(key))) return settingsError("invalid", "Invalid person settings schema");
  if (value.autoCollapse !== null && typeof value.autoCollapse !== "boolean") return settingsError("invalid", "Auto-collapse must be set to a boolean or explicitly unset");
  let timezone: PersonTimezone | null = null;
  if (value.timezone !== null) {
    if (!settingsObject(value.timezone) || typeof value.timezone.observedAt !== "string") return settingsError("invalid", "Timezone provenance is missing");
    const parsed = parseTimezone(value.timezone, value.timezone.observedAt);
    if (!parsed.ok) return parsed;
    timezone = parsed.value;
  }
  return { ok: true, value: { version: 1, timezone, autoCollapse: value.autoCollapse } };
}
