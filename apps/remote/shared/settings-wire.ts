import { parseTimezone, type SettingValue, type SettingEntry, type SettingsSnapshot } from "./settings";

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

export function parseSettingsEntry(value: unknown): Parsed<SettingEntry> {
  if (!object(value) || !object(value.definition) || !object(value.value) || typeof value.editable !== "boolean") return { ok: false, error: "Invalid settings entry" };
  const definition = value.definition;
  if (typeof definition.id !== "string" || !definition.id || typeof definition.label !== "string" || typeof definition.description !== "string" || typeof definition.activation !== "string" || (definition.scope !== "person" && definition.scope !== "system") || (definition.kind !== "timezone" && definition.kind !== "boolean" && definition.kind !== "owner") || !object(definition.owner) || typeof definition.owner.component !== "string" || typeof definition.owner.location !== "string" || (definition.owner.command !== null && typeof definition.owner.command !== "string")) return { ok: false, error: "Invalid settings definition" };
  const setting = value.value;
  let settingValue: SettingValue | undefined;
  switch (setting.state) {
    case "set": {
      if (!Object.hasOwn(setting, "value")) return { ok: false, error: "Setting value is missing" };
      if (definition.kind === "boolean" && typeof setting.value !== "boolean") return { ok: false, error: `Invalid boolean value for ${definition.label}` };
      if (definition.kind === "timezone") {
        if (!object(setting.value) || typeof setting.value.observedAt !== "string") return { ok: false, error: "Timezone provenance is missing" };
        const parsed = parseTimezone(setting.value, setting.value.observedAt);
        if (!parsed.ok) return { ok: false, error: parsed.error.message };
      }
      settingValue = { state: "set", value: setting.value };
      break;
    }
    case "unset": settingValue = { state: "unset" }; break;
    case "unavailable":
      if (typeof setting.message !== "string") return { ok: false, error: "Unavailable setting has no reason" };
      settingValue = { state: "unavailable", message: setting.message }; break;
  }
  if (settingValue === undefined) return { ok: false, error: "Unknown settings value state" };
  return { ok: true, value: { definition: { id: definition.id, label: definition.label, description: definition.description, scope: definition.scope, kind: definition.kind, activation: definition.activation, owner: { component: definition.owner.component, location: definition.owner.location, command: definition.owner.command } }, value: settingValue, editable: value.editable } };
}

export function parseSettingsSnapshot(value: unknown): Parsed<SettingsSnapshot> {
  if (!object(value) || typeof value.administrator !== "boolean" || !Array.isArray(value.entries)) return { ok: false, error: "Invalid settings response" };
  const entries: SettingEntry[] = [];
  const ids = new Set<string>();
  for (const raw of value.entries) {
    const parsed = parseSettingsEntry(raw);
    if (!parsed.ok) return parsed;
    if (ids.has(parsed.value.definition.id)) return { ok: false, error: "Duplicate settings identifier" };
    if (!value.administrator && parsed.value.definition.scope === "system") return { ok: false, error: "The settings response contains unauthorized system entries" };
    ids.add(parsed.value.definition.id); entries.push(parsed.value);
  }
  return { ok: true, value: { administrator: value.administrator, entries } };
}
