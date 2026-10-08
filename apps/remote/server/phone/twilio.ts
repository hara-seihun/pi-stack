import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Result } from "./policy";

export type TwilioCredentials = { TWILIO_ACCOUNT_SID: string; TWILIO_AUTH_TOKEN: string; TWILIO_FROM_NUMBER: string };
export type TwilioSettings = { accountSid: string; apiToken: string; signingKey: string; callerId: string; signatureHeader: "x-twilio-signature" };
export type DialResult = { ok: true; value: { uuid: string } } | { ok: false; error: string; uncertain: boolean };
export const twilioTerminal = new Set(["completed", "busy", "canceled", "no-answer", "failed"]);

export function twilioCredentials(value: unknown): Result<TwilioSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Twilio credential object required" };
  const c = value as Record<string, unknown>;
  const keys = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"];
  if (Object.keys(c).some(k => !keys.includes(k)) || keys.some(k => typeof c[k] !== "string" || !(c[k] as string).trim())) return { ok: false, error: "Twilio credentials require exactly the documented nonempty fields" };
  const t = c as TwilioCredentials;
  if (!/^AC[0-9a-fA-F]{32}$/.test(t.TWILIO_ACCOUNT_SID) || !/^\+[1-9]\d{7,14}$/.test(t.TWILIO_FROM_NUMBER)) return { ok: false, error: "Invalid Twilio account SID or E.164 caller number" };
  return { ok: true, value: { accountSid: t.TWILIO_ACCOUNT_SID, apiToken: t.TWILIO_AUTH_TOKEN, signingKey: t.TWILIO_AUTH_TOKEN, callerId: t.TWILIO_FROM_NUMBER, signatureHeader: "x-twilio-signature" } };
}
export function twilioSignature(key: string, url: string, params: URLSearchParams): string {
  let input = url;
  for (const name of [...new Set(params.keys())].sort()) for (const value of [...new Set(params.getAll(name))].sort()) input += name + value;
  return createHmac("sha1", key).update(input).digest("base64");
}
export function signedTwilioWebhook(header: string | null, key: string, url: string, params: URLSearchParams): boolean {
  if (!header || !key || !/^[A-Za-z0-9+/]{27}=$/.test(header)) return false;
  const expected = Buffer.from(twilioSignature(key, url, params)), actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function signedTwilioUpgrade(header: string | null, key: string, publicUrl: string): boolean {
  const params = new URLSearchParams();
  return signedTwilioWebhook(header, key, publicUrl, params) || signedTwilioWebhook(header, key, publicUrl.replace(/^https:/, "wss:"), params);
}
const xmlEscape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
export function twilioStream(mediaUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xmlEscape(mediaUrl)}" /></Connect></Response>`;
}
export const twilioUnavailable = '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Kenan is unavailable. Please call again later.</Say><Hangup /></Response>';
export const twilioEnded = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup /></Response>';

type RequestResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string; uncertain: boolean };
export class Twilio {
  readonly settings: TwilioSettings;
  constructor(path: string) {
    const parsed = twilioCredentials(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.ok) throw new Error(parsed.error);
    this.settings = parsed.value;
  }
  private async request(path: string, method: "GET" | "POST", body?: URLSearchParams): Promise<RequestResult> {
    try {
      const c = this.settings;
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}${path}`, {
        method, headers: { authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.apiToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
        body, signal: AbortSignal.timeout(15_000), redirect: "error",
      });
      if (!response.ok) return { ok: false, error: `Twilio HTTP ${response.status}`, uncertain: response.status >= 500 || response.status === 408 };
      const value = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Malformed Twilio response", uncertain: true };
      return { ok: true, value };
    } catch { return { ok: false, error: "Twilio request outcome unknown", uncertain: true }; }
  }
  async dial(to: string, instruction: string, eventUrl: string, maxSeconds: number): Promise<DialResult> {
    if (!Number.isInteger(maxSeconds) || maxSeconds < 30 || maxSeconds > 1800) return { ok: false, error: "Call duration must be 30–1800 seconds", uncertain: false };
    const params = new URLSearchParams({ To: to, From: this.settings.callerId, Twiml: instruction, StatusCallback: eventUrl, StatusCallbackMethod: "POST", Timeout: "30", TimeLimit: String(maxSeconds) });
    for (const event of ["initiated", "ringing", "answered", "completed"]) params.append("StatusCallbackEvent", event);
    const result = await this.request("/Calls.json", "POST", params);
    if (!result.ok) return result;
    if (typeof result.value.sid !== "string" || !result.value.sid || result.value.sid.length > 200) return { ok: false, error: "Twilio dial accepted without a call ID; outcome unknown", uncertain: true };
    return { ok: true, value: { uuid: result.value.sid } };
  }
  async hangup(id: string): Promise<Result<unknown>> {
    const path = `/Calls/${encodeURIComponent(id)}.json`;
    const result = await this.request(path, "POST", new URLSearchParams({ Status: "completed" }));
    if (result.ok) return result;
    const current = await this.request(path, "GET");
    if (current.ok && twilioTerminal.has(String(current.value.status))) return { ok: true, value: { ended: true } };
    if (current.ok && ["queued", "ringing"].includes(String(current.value.status))) return this.request(path, "POST", new URLSearchParams({ Status: "canceled" }));
    return result;
  }
}
