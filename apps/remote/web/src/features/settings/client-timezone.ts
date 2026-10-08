import { API } from "../../../../server/api";
import { api } from "../../client";
import { parseSettingsEntry } from "../../../../shared/settings-wire";

export type ClientTimezoneObservation = { ok: true } | { ok: false; error: string };

export async function observeClientTimezone(): Promise<ClientTimezoneObservation> {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone) return { ok: false, error: "This browser did not report a timezone. Choose one in Settings." };
    const result = await api(API.updateSetting.method, API.updateSetting.path({ id: "person.timezone" }), { value: { zone, source: "client-observed" } });
    const parsed = parseSettingsEntry(result.entry);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    if (parsed.value.definition.id !== "person.timezone" || parsed.value.value.state !== "set") return { ok: false, error: "The server did not confirm a timezone setting." };
    window.dispatchEvent(new Event("pi-settings-changed"));
    return { ok: true };
  } catch (failure) {
    return { ok: false, error: `Could not record this device’s timezone: ${failure instanceof Error ? failure.message : String(failure)}` };
  }
}
