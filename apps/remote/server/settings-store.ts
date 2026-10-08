import { readPersonSettings, readPersonTimezone, writePersonSetting } from "pi-orchestrator/api";
import { settingsError, settingsObject, type SettingsResult } from "pi-orchestrator/person-settings-contract";
import { SETTINGS, settingDefinition, validateSettingValue, type SettingDefinition, type SettingEntry, type SettingsSnapshot, type SettingValue } from "../shared/settings";
export { readPersonTimezone };
export type OwnedSettingAdapter = { definition: SettingDefinition; read(): Promise<SettingsResult<unknown>>; write(value: unknown): Promise<SettingsResult<unknown>> };
export class SettingsService {
  constructor(private readonly dataDir: string, private readonly administrator: boolean, private readonly adapters: () => OwnedSettingAdapter[]) {}
  private personalEntries(): SettingEntry[] {
    const stored = readPersonSettings(this.dataDir);
    return SETTINGS.filter(definition => definition.scope === "person" || this.administrator).map(definition => {
      let value: SettingValue = definition.kind === "owner"
        ? { state: "unavailable", message: "Read and change this configuration through its declared owner; browser editing is not available" }
        : { state: "unset" };
      if (definition.id === "person.timezone" || definition.id === "person.autoCollapse") {
        if (!stored.ok) value = { state: "unavailable", message: stored.error.message };
        else {
          const setting = definition.id === "person.timezone" ? stored.value.timezone : stored.value.autoCollapse;
          value = setting === null ? { state: "unset" } : { state: "set", value: setting };
        }
      }
      return { definition, value, editable: definition.kind !== "owner" };
    });
  }
  async snapshot(): Promise<SettingsSnapshot> {
    const entries = this.personalEntries();
    const owned = await Promise.all(this.adapters().filter(adapter => adapter.definition.scope === "person" || this.administrator).map(async adapter => {
      const read = await adapter.read();
      return { definition: adapter.definition, value: read.ok ? { state: "set" as const, value: read.value } : { state: "unavailable" as const, message: read.error.message }, editable: read.ok && adapter.definition.kind !== "owner" };
    }));
    return { administrator: this.administrator, entries: [...entries, ...owned] };
  }
  async update(id: string, body: unknown): Promise<SettingsResult<SettingEntry>> {
    const adapter = this.adapters().find(item => item.definition.id === id);
    const definition = settingDefinition(id) ?? adapter?.definition;
    if (!definition) return settingsError("unknown-setting", "Unknown registered setting");
    if (definition.scope === "system" && !this.administrator) return settingsError("forbidden", "Only the host administrator can read or change system settings");
    if (!settingsObject(body) || !Object.hasOwn(body, "value") || Object.keys(body).length !== 1) return settingsError("invalid", "Expected a single registered setting value");
    const parsed = validateSettingValue(definition, body.value);
    if (!parsed.ok) return parsed;
    if (id === "person.timezone" || id === "person.autoCollapse") {
      const written = writePersonSetting(this.dataDir, id, parsed.value);
      if (!written.ok) return written;
      const value = id === "person.timezone" ? written.value.timezone : written.value.autoCollapse;
      return { ok: true, value: { definition, value: value === null ? { state: "unset" } : { state: "set", value }, editable: true } };
    }
    if (!adapter) return settingsError("owner-managed", "This setting must be changed through its declared owner");
    const written = await adapter.write(parsed.value);
    return written.ok ? { ok: true, value: { definition, value: { state: "set", value: written.value }, editable: true } } : written;
  }
}
