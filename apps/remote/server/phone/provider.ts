import { Vonage } from "./vonage";
import { Retell } from "./retell";
import { Compatibility, compatibilityStream, type CompatibilityKind, type DialResult } from "./compatibility";
import type { Result } from "./policy";

export type ProviderKind = "vonage" | CompatibilityKind | "retell";
export type PhoneProvider =
  | { kind: "vonage"; client: Vonage; callerId: string }
  | { kind: CompatibilityKind; client: Compatibility; callerId: string }
  | { kind: "retell"; client: Retell; callerId: string };
export type ProviderConfig = { pstnProvider?: unknown; vonageCredentialFile?: string; signalwireCredentialFile?: string; twilioCredentialFile?: string; retellCredentialFile?: string; publicBaseUrl?: string };
export function providerSelection(config: ProviderConfig): Result<ProviderKind | null> {
  if (config.pstnProvider !== null && config.pstnProvider !== "vonage" && config.pstnProvider !== "signalwire" && config.pstnProvider !== "twilio" && config.pstnProvider !== "retell") return { ok: false, error: "pstnProvider must explicitly be vonage, signalwire, twilio, retell, or null (SIM-only)" };
  if (config.pstnProvider === null) return { ok: true, value: null };
  const file = credentialFile(config.pstnProvider, config);
  if (typeof file !== "string" || !file.startsWith("/")) return { ok: false, error: `An absolute ${config.pstnProvider} credential file is required` };
  if (config.pstnProvider === "retell") return { ok: true, value: "retell" };
  try {
    const url = new URL(config.publicBaseUrl!);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return { ok: false, error: "PSTN requires a public HTTPS/WSS callback base without credentials, query or fragment" };
  } catch { return { ok: false, error: "PSTN requires a public HTTPS/WSS callback base" }; }
  return { ok: true, value: config.pstnProvider };
}
function credentialFile(kind: ProviderKind, config: ProviderConfig) {
  switch (kind) {
    case "vonage": return config.vonageCredentialFile;
    case "signalwire": return config.signalwireCredentialFile;
    case "twilio": return config.twilioCredentialFile;
    case "retell": return config.retellCredentialFile;
  }
}
export function loadProvider(kind: ProviderKind, config: ProviderConfig): Result<PhoneProvider> {
  const file = credentialFile(kind, config);
  if (!file) return { ok: false, error: `${kind} cleanup credentials are not configured` };
  try {
    if (kind === "vonage") { const client = new Vonage(file); return { ok: true, value: { kind, client, callerId: client.credentials.VONAGE_FROM_NUMBER } }; }
    if (kind === "retell") { const client = new Retell(file); return { ok: true, value: { kind, client, callerId: client.settings.callerId } }; }
    const client = new Compatibility(kind, file);
    return { ok: true, value: { kind, client, callerId: client.settings.callerId } };
  } catch { return { ok: false, error: `${kind} credentials could not be loaded or validated` }; }
}
export function mediaInstructions(provider: PhoneProvider, base: string, token: string, id: string): unknown[] | string {
  if (provider.kind === "retell") throw new Error("Retell manages its own voice; no media instructions exist");
  const path = provider.kind === "twilio" ? `/twilio/media/${encodeURIComponent(id)}/${encodeURIComponent(token)}` : `/${provider.kind}/media`;
  const uri = base.replace(/^https:/, "wss:") + path;
  if (provider.kind !== "vonage") return compatibilityStream(provider.kind, uri, token);
  return [{ action: "connect", endpoint: [{ type: "websocket", uri, "content-type": "audio/l16;rate=16000", authorization: { type: "custom", value: `Bearer ${token}` }, headers: { callId: id } }] }];
}
export async function dial(provider: PhoneProvider, to: string, base: string, token: string, id: string): Promise<DialResult> {
  if (provider.kind === "retell") throw new Error("Retell dialing requires an approved call brief");
  const instruction = mediaInstructions(provider, base, token, id), events = `${base}/${provider.kind}/events/${id}`;
  if (provider.kind !== "vonage") return provider.client.dial(to, instruction as string, events);
  const result = await provider.client.dial(to, instruction as unknown[], events);
  if (!result.ok) {
    const status = /^Vonage HTTP (\d+):/.exec(result.error);
    return { ...result, uncertain: !status || Number(status[1]) >= 500 || Number(status[1]) === 408 };
  }
  if (typeof result.value.uuid !== "string" || !result.value.uuid || result.value.uuid.length > 200) return { ok: false, error: "Vonage dial accepted without a call ID; outcome unknown", uncertain: true };
  return result;
}
