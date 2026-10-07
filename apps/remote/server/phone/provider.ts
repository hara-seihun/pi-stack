import { Vonage } from "./vonage";
import { SignalWire, signalWireStream, type DialResult } from "./signalwire";
import type { Result } from "./policy";

export type ProviderKind = "vonage" | "signalwire";
export type PhoneProvider =
  | { kind: "vonage"; client: Vonage; callerId: string }
  | { kind: "signalwire"; client: SignalWire; callerId: string };
export type ProviderConfig = { pstnProvider?: unknown; vonageCredentialFile?: string; signalwireCredentialFile?: string; publicBaseUrl?: string };
export function providerSelection(config: ProviderConfig): Result<ProviderKind | null> {
  if (config.pstnProvider !== null && config.pstnProvider !== "vonage" && config.pstnProvider !== "signalwire") return { ok: false, error: "pstnProvider must explicitly be vonage, signalwire, or null (SIM-only)" };
  if (config.pstnProvider === null) return { ok: true, value: null };
  const file = config.pstnProvider === "vonage" ? config.vonageCredentialFile : config.signalwireCredentialFile;
  if (typeof file !== "string" || !file.startsWith("/")) return { ok: false, error: `An absolute ${config.pstnProvider} credential file is required` };
  try {
    const url = new URL(config.publicBaseUrl!);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return { ok: false, error: "PSTN requires a public HTTPS/WSS callback base without credentials, query or fragment" };
  } catch { return { ok: false, error: "PSTN requires a public HTTPS/WSS callback base" }; }
  return { ok: true, value: config.pstnProvider };
}
export function loadProvider(kind: ProviderKind, config: ProviderConfig): Result<PhoneProvider> {
  const file = kind === "vonage" ? config.vonageCredentialFile : config.signalwireCredentialFile;
  if (!file) return { ok: false, error: `${kind} cleanup credentials are not configured` };
  try {
    if (kind === "vonage") { const client = new Vonage(file); return { ok: true, value: { kind, client, callerId: client.credentials.VONAGE_FROM_NUMBER } }; }
    const client = new SignalWire(file);
    return { ok: true, value: { kind, client, callerId: client.credentials.SIGNALWIRE_FROM_NUMBER } };
  } catch { return { ok: false, error: `${kind} credentials could not be loaded or validated` }; }
}
export function mediaInstructions(provider: PhoneProvider, base: string, token: string, id: string): unknown[] | string {
  const uri = `${base.replace(/^https:/, "wss:")}/${provider.kind}/media`;
  if (provider.kind === "signalwire") return signalWireStream(uri, token);
  return [{ action: "connect", endpoint: [{ type: "websocket", uri, "content-type": "audio/l16;rate=16000", authorization: { type: "custom", value: `Bearer ${token}` }, headers: { callId: id } }] }];
}
export async function dial(provider: PhoneProvider, to: string, base: string, token: string, id: string, maxSeconds: number): Promise<DialResult> {
  const instruction = mediaInstructions(provider, base, token, id), events = `${base}/${provider.kind}/events/${id}`;
  if (provider.kind === "signalwire") return provider.client.dial(to, instruction as string, events);
  const result = await provider.client.dial(to, instruction as unknown[], events);
  if (!result.ok) {
    const status = /^Vonage HTTP (\d+):/.exec(result.error);
    return { ...result, uncertain: !status || Number(status[1]) >= 500 || Number(status[1]) === 408 };
  }
  if (typeof result.value.uuid !== "string" || !result.value.uuid || result.value.uuid.length > 200) return { ok: false, error: "Vonage dial accepted without a call ID; outcome unknown", uncertain: true };
  return result;
}
