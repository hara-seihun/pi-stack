import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Result } from "./policy";

export type CompatibilityKind = "signalwire" | "twilio";
export type SignalWireCredentials = { SIGNALWIRE_SPACE_URL: string; SIGNALWIRE_PROJECT_ID: string; SIGNALWIRE_API_TOKEN: string; SIGNALWIRE_SIGNING_KEY: string; SIGNALWIRE_FROM_NUMBER: string };
export type TwilioCredentials = { TWILIO_ACCOUNT_SID: string; TWILIO_AUTH_TOKEN: string; TWILIO_FROM_NUMBER: string };
export type CompatibilitySettings = { kind: CompatibilityKind; origin: string; accountSid: string; apiToken: string; signingKey: string; callerId: string; apiPrefix: string; instructionField: "Laml" | "Twiml"; signatureHeader: "x-signalwire-signature" | "x-twilio-signature" };
export type DialResult = { ok: true; value: { uuid: string } } | { ok: false; error: string; uncertain: boolean };
export const compatibilityTerminal = new Set(["completed", "busy", "canceled", "no-answer", "failed"]);

export function compatibilityCredentials(kind: CompatibilityKind, value: unknown): Result<CompatibilitySettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: `${kind} credential object required` };
  const c = value as Record<string, unknown>;
  const keys = kind === "signalwire" ? ["SIGNALWIRE_SPACE_URL", "SIGNALWIRE_PROJECT_ID", "SIGNALWIRE_API_TOKEN", "SIGNALWIRE_SIGNING_KEY", "SIGNALWIRE_FROM_NUMBER"] : ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"];
  if (Object.keys(c).some(k => !keys.includes(k)) || keys.some(k => typeof c[k] !== "string" || !(c[k] as string).trim())) return { ok: false, error: `${kind} credentials require exactly the documented nonempty fields` };
  if (kind === "twilio") {
    const t = c as TwilioCredentials;
    if (!/^AC[0-9a-fA-F]{32}$/.test(t.TWILIO_ACCOUNT_SID) || !/^\+[1-9]\d{7,14}$/.test(t.TWILIO_FROM_NUMBER)) return { ok: false, error: "Invalid Twilio account SID or E.164 caller number" };
    return { ok: true, value: { kind, origin: "https://api.twilio.com", accountSid: t.TWILIO_ACCOUNT_SID, apiToken: t.TWILIO_AUTH_TOKEN, signingKey: t.TWILIO_AUTH_TOKEN, callerId: t.TWILIO_FROM_NUMBER, apiPrefix: "/2010-04-01", instructionField: "Twiml", signatureHeader: "x-twilio-signature" } };
  }
  const s = c as SignalWireCredentials;
  try {
    const url = new URL(s.SIGNALWIRE_SPACE_URL);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.signalwire\.com$/.test(url.hostname) || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return { ok: false, error: "SignalWire space must be an HTTPS origin under signalwire.com" };
    if (!/^[a-zA-Z0-9-]+$/.test(s.SIGNALWIRE_PROJECT_ID) || !/^\+[1-9]\d{7,14}$/.test(s.SIGNALWIRE_FROM_NUMBER)) return { ok: false, error: "Invalid SignalWire project ID or E.164 caller number" };
    return { ok: true, value: { kind, origin: url.origin, accountSid: s.SIGNALWIRE_PROJECT_ID, apiToken: s.SIGNALWIRE_API_TOKEN, signingKey: s.SIGNALWIRE_SIGNING_KEY, callerId: s.SIGNALWIRE_FROM_NUMBER, apiPrefix: "/api/laml/2010-04-01", instructionField: "Laml", signatureHeader: "x-signalwire-signature" } };
  } catch { return { ok: false, error: "Invalid SignalWire space URL" }; }
}
export function compatibilitySignature(key: string, url: string, params: URLSearchParams): string {
  let input = url;
  for (const name of [...new Set(params.keys())].sort()) for (const value of [...new Set(params.getAll(name))].sort()) input += name + value;
  return createHmac("sha1", key).update(input).digest("base64");
}
export function signedCompatibilityWebhook(header: string | null, key: string, url: string, params: URLSearchParams): boolean {
  if (!header || !key || !/^[A-Za-z0-9+/]{27}=$/.test(header)) return false;
  const expected = Buffer.from(compatibilitySignature(key, url, params)), actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function signedTwilioUpgrade(header: string | null, key: string, publicUrl: string): boolean {
  const params = new URLSearchParams();
  return signedCompatibilityWebhook(header, key, publicUrl, params) || signedCompatibilityWebhook(header, key, publicUrl.replace(/^https:/, "wss:"), params);
}
const xmlEscape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
export function compatibilityStream(kind: CompatibilityKind, mediaUrl: string, bearer: string): string {
  const auth = kind === "signalwire" ? ` authBearerToken="${xmlEscape(bearer)}" codec="PCMU@8000h" realtime="true" track="inbound_track"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xmlEscape(mediaUrl)}"${auth} /></Connect></Response>`;
}
export const compatibilityUnavailable = '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Kenan is unavailable. Please call again later.</Say><Hangup /></Response>';
export const compatibilityEnded = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup /></Response>';

export class Compatibility {
  readonly settings: CompatibilitySettings;
  constructor(kind: CompatibilityKind, path: string) {
    const parsed = compatibilityCredentials(kind, JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.ok) throw new Error(parsed.error);
    this.settings = parsed.value;
  }
  private async request(path: string, method: "GET" | "POST", body?: URLSearchParams): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string; uncertain: boolean }> {
    try {
      const c = this.settings;
      const response = await fetch(`${c.origin}${c.apiPrefix}/Accounts/${encodeURIComponent(c.accountSid)}${path}`, {
        method, headers: { authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.apiToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
        body, signal: AbortSignal.timeout(15_000), redirect: "error",
      });
      if (!response.ok) return { ok: false, error: `${c.kind} HTTP ${response.status}`, uncertain: response.status >= 500 || response.status === 408 };
      const value = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: `Malformed ${c.kind} response`, uncertain: true };
      return { ok: true, value };
    } catch { return { ok: false, error: `${this.settings.kind} request outcome unknown`, uncertain: true }; }
  }
  async dial(to: string, instruction: string, eventUrl: string): Promise<DialResult> {
    const params = new URLSearchParams({ To: to, From: this.settings.callerId, [this.settings.instructionField]: instruction, StatusCallback: eventUrl, StatusCallbackMethod: "POST", Timeout: "30" });
    for (const event of ["initiated", "ringing", "answered", "completed"]) params.append("StatusCallbackEvent", event);
    const result = await this.request("/Calls.json", "POST", params);
    if (!result.ok) return result;
    if (typeof result.value.sid !== "string" || !result.value.sid || result.value.sid.length > 200) return { ok: false, error: `${this.settings.kind} dial accepted without a call ID; outcome unknown`, uncertain: true };
    return { ok: true, value: { uuid: result.value.sid } };
  }
  async hangup(id: string): Promise<Result<unknown>> {
    const path = `/Calls/${encodeURIComponent(id)}.json`;
    const result = await this.request(path, "POST", new URLSearchParams({ Status: "completed" }));
    if (result.ok) return result;
    const current = await this.request(path, "GET");
    if (current.ok && compatibilityTerminal.has(String(current.value.status))) return { ok: true, value: { ended: true } };
    if (this.settings.kind === "twilio" && current.ok && ["queued", "ringing"].includes(String(current.value.status))) return this.request(path, "POST", new URLSearchParams({ Status: "canceled" }));
    return result;
  }
}
