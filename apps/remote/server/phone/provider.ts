import { RetellTakeover, silentUrl } from "./retell-transport";
import type { Result } from "./policy";

export type ProviderKind = "retell-takeover";
export type PhoneProvider = { kind: ProviderKind; client: RetellTakeover; callerId: string };
export type ProviderConfig = { callingEnabled?: unknown; pstnProvider?: unknown; retellCredentialFile?: string; silentTokenFile?: string; publicBaseUrl?: string };
export function providerSelection(config: ProviderConfig): Result<ProviderKind | null> {
  if (typeof config.callingEnabled !== "boolean") return { ok: false, error: "callingEnabled must explicitly be true or false" };
  if (config.pstnProvider !== null && config.pstnProvider !== "retell-takeover") return { ok: false, error: "pstnProvider must explicitly be retell-takeover or null (PSTN disabled)" };
  if (config.pstnProvider === null) return config.callingEnabled ? { ok: false, error: "Enabled calling requires the silent Retell takeover transport" } : { ok: true, value: null };
  if (typeof config.retellCredentialFile !== "string" || !config.retellCredentialFile.startsWith("/") || typeof config.silentTokenFile !== "string" || !config.silentTokenFile.startsWith("/")) return { ok: false, error: "Absolute Retell credential and silent token files are required" };
  try {
    const url = new URL(config.publicBaseUrl!);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return { ok: false, error: "PSTN requires a public HTTPS origin without credentials, path, query or fragment" };
  } catch { return { ok: false, error: "PSTN requires a public HTTPS origin" }; }
  return { ok: true, value: "retell-takeover" };
}
export function loadProvider(kind: ProviderKind, config: ProviderConfig): Result<PhoneProvider> {
  if (kind !== "retell-takeover") return { ok: false, error: "Only the deterministic silent Retell takeover transport is supported" };
  const selection = providerSelection({ ...config, callingEnabled: false, pstnProvider: kind });
  if (!selection.ok) return selection;
  const url = silentUrl(config.publicBaseUrl!, config.silentTokenFile!);
  if (!url.ok) return url;
  try {
    const client = new RetellTakeover(config.retellCredentialFile!, url.value);
    return { ok: true, value: { kind, client, callerId: client.settings.callerId } };
  } catch { return { ok: false, error: "Retell takeover credentials could not be loaded or validated" }; }
}
