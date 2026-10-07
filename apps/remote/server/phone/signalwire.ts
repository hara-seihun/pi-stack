import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Result } from "./policy";

export type SignalWireCredentials = {
  SIGNALWIRE_SPACE_URL: string;
  SIGNALWIRE_PROJECT_ID: string;
  SIGNALWIRE_API_TOKEN: string;
  SIGNALWIRE_SIGNING_KEY: string;
  SIGNALWIRE_FROM_NUMBER: string;
};
export type DialResult = { ok: true; value: { uuid: string } } | { ok: false; error: string; uncertain: boolean };
export const signalWireTerminal = new Set(["completed", "busy", "canceled", "no-answer", "failed"]);

export function signalWireCredentials(value: unknown): Result<SignalWireCredentials> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "SignalWire credential object required" };
  const c = value as Record<string, unknown>;
  const keys = ["SIGNALWIRE_SPACE_URL", "SIGNALWIRE_PROJECT_ID", "SIGNALWIRE_API_TOKEN", "SIGNALWIRE_SIGNING_KEY", "SIGNALWIRE_FROM_NUMBER"];
  if (Object.keys(c).some(k => !keys.includes(k)) || keys.some(k => typeof c[k] !== "string" || !(c[k] as string).trim())) return { ok: false, error: "SignalWire credentials require exactly the documented nonempty fields" };
  try {
    const url = new URL(c.SIGNALWIRE_SPACE_URL as string);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.signalwire\.com$/.test(url.hostname) || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return { ok: false, error: "SignalWire space must be an HTTPS origin under signalwire.com" };
    if (!/^[a-zA-Z0-9-]+$/.test(c.SIGNALWIRE_PROJECT_ID as string) || !/^\+[1-9]\d{7,14}$/.test(c.SIGNALWIRE_FROM_NUMBER as string)) return { ok: false, error: "Invalid SignalWire project ID or E.164 caller number" };
    return { ok: true, value: { ...c, SIGNALWIRE_SPACE_URL: url.origin } as SignalWireCredentials };
  } catch { return { ok: false, error: "Invalid SignalWire space URL" }; }
}

export function signalWireSignature(key: string, url: string, params: URLSearchParams): string {
  let input = url;
  for (const name of [...new Set(params.keys())].sort()) for (const value of [...new Set(params.getAll(name))].sort()) input += name + value;
  return createHmac("sha1", key).update(input).digest("base64");
}
export function signedSignalWireWebhook(header: string | null, key: string, url: string, params: URLSearchParams): boolean {
  if (!header || !key || !/^[A-Za-z0-9+/]{27}=$/.test(header)) return false;
  const expected = Buffer.from(signalWireSignature(key, url, params));
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const xmlEscape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
export function signalWireStream(mediaUrl: string, bearer: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xmlEscape(mediaUrl)}" authBearerToken="${xmlEscape(bearer)}" codec="PCMU@8000h" realtime="true" track="inbound_track" /></Connect></Response>`;
}
export const signalWireUnavailable = '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Kenan is unavailable. Please call again later.</Say><Hangup /></Response>';
export const signalWireEnded = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup /></Response>';

export class SignalWire {
  readonly credentials: SignalWireCredentials;
  constructor(path: string) {
    const parsed = signalWireCredentials(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.ok) throw new Error(parsed.error);
    this.credentials = parsed.value;
  }
  private async request(path: string, method: "GET" | "POST", body?: URLSearchParams): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string; uncertain: boolean }> {
    try {
      const c = this.credentials;
      const response = await fetch(`${c.SIGNALWIRE_SPACE_URL}/api/laml/2010-04-01/Accounts/${encodeURIComponent(c.SIGNALWIRE_PROJECT_ID)}${path}`, {
        method, headers: { authorization: `Basic ${Buffer.from(`${c.SIGNALWIRE_PROJECT_ID}:${c.SIGNALWIRE_API_TOKEN}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
        body, signal: AbortSignal.timeout(15_000), redirect: "error",
      });
      if (!response.ok) return { ok: false, error: `SignalWire HTTP ${response.status}`, uncertain: response.status >= 500 || response.status === 408 };
      const value = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Malformed SignalWire response", uncertain: true };
      return { ok: true, value };
    } catch { return { ok: false, error: "SignalWire request outcome unknown", uncertain: true }; }
  }
  async dial(to: string, laml: string, eventUrl: string): Promise<DialResult> {
    const params = new URLSearchParams({ To: to, From: this.credentials.SIGNALWIRE_FROM_NUMBER, Laml: laml, StatusCallback: eventUrl, StatusCallbackMethod: "POST", Timeout: "30" });
    for (const event of ["initiated", "ringing", "answered", "completed"]) params.append("StatusCallbackEvent", event);
    const result = await this.request("/Calls.json", "POST", params);
    if (!result.ok) return result;
    if (typeof result.value.sid !== "string" || !result.value.sid || result.value.sid.length > 200) return { ok: false, error: "SignalWire dial accepted without a call ID; outcome unknown", uncertain: true };
    return { ok: true, value: { uuid: result.value.sid } };
  }
  async hangup(id: string): Promise<Result<unknown>> {
    const path = `/Calls/${encodeURIComponent(id)}.json`;
    const result = await this.request(path, "POST", new URLSearchParams({ Status: "completed" }));
    if (result.ok) return result;
    const current = await this.request(path, "GET");
    if (current.ok && signalWireTerminal.has(String(current.value.status))) return { ok: true, value: { ended: true } };
    return result;
  }
}
