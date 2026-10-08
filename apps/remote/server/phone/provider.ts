import { Twilio, twilioStream, type DialResult } from "./twilio";
import type { Result } from "./policy";

export type ProviderKind = "twilio";
export type PhoneProvider = { kind: "twilio"; client: Twilio; callerId: string };
export type ProviderConfig = { callingEnabled?: unknown; pstnProvider?: unknown; twilioCredentialFile?: string; publicBaseUrl?: string };
export function providerSelection(config: ProviderConfig): Result<ProviderKind | null> {
  if (typeof config.callingEnabled !== "boolean") return { ok: false, error: "callingEnabled must explicitly be true or false" };
  if (config.pstnProvider !== null && config.pstnProvider !== "twilio") return { ok: false, error: "pstnProvider must explicitly be twilio or null (PSTN disabled)" };
  if (config.pstnProvider === null) return config.callingEnabled
    ? { ok: false, error: "Enabled calling requires the Twilio raw media transport" }
    : { ok: true, value: null };
  if (typeof config.twilioCredentialFile !== "string" || !config.twilioCredentialFile.startsWith("/")) return { ok: false, error: "An absolute Twilio credential file is required" };
  try {
    const url = new URL(config.publicBaseUrl!);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return { ok: false, error: "PSTN requires a public HTTPS/WSS callback base without credentials, query or fragment" };
  } catch { return { ok: false, error: "PSTN requires a public HTTPS/WSS callback base" }; }
  return { ok: true, value: "twilio" };
}
export function loadProvider(kind: ProviderKind, config: ProviderConfig): Result<PhoneProvider> {
  if (kind !== "twilio") return { ok: false, error: "Only the Twilio raw media transport is supported" };
  const file = config.twilioCredentialFile;
  if (typeof file !== "string" || !file.startsWith("/")) return { ok: false, error: "An absolute Twilio cleanup credential file is required" };
  try {
    const client = new Twilio(file);
    return { ok: true, value: { kind, client, callerId: client.settings.callerId } };
  } catch { return { ok: false, error: "Twilio credentials could not be loaded or validated" }; }
}
export function mediaInstructions(_provider: PhoneProvider, base: string, token: string, id: string): string {
  return twilioStream(base.replace(/^https:/, "wss:") + `/twilio/media/${encodeURIComponent(id)}/${encodeURIComponent(token)}`);
}
export async function dial(provider: PhoneProvider, to: string, base: string, token: string, id: string, maxSeconds: number): Promise<DialResult> {
  return provider.client.dial(to, mediaInstructions(provider, base, token, id), `${base}/twilio/events/${encodeURIComponent(id)}`, maxSeconds);
}
