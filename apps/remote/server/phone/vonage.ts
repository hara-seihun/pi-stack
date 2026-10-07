import { randomUUID, sign, createPrivateKey, createHmac, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Result } from "./policy";
export type Credentials = { VONAGE_APPLICATION_ID: string; VONAGE_PRIVATE_KEY: string; VONAGE_SIGNATURE_SECRET: string; VONAGE_FROM_NUMBER: string };
export class Vonage {
  readonly credentials: Credentials;
  constructor(path: string) {
    const c = JSON.parse(readFileSync(path, "utf8"));
    if (!c || typeof c !== "object" || Array.isArray(c) || ["VONAGE_APPLICATION_ID", "VONAGE_PRIVATE_KEY", "VONAGE_SIGNATURE_SECRET", "VONAGE_FROM_NUMBER"].some(k => typeof c[k] !== "string" || !c[k].trim()) || !/^\+?[1-9]\d{7,14}$/.test(c.VONAGE_FROM_NUMBER)) throw new Error("Valid Vonage credentials and caller number required");
    if (createPrivateKey(c.VONAGE_PRIVATE_KEY).asymmetricKeyType !== "rsa") throw new Error("Vonage requires an RSA private key");
    this.credentials = c;
  }
  private jwt() {
    const enc = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const data = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ application_id: this.credentials.VONAGE_APPLICATION_ID, iat: now, exp: now + 120, jti: randomUUID() })}`;
    return `${data}.${sign("RSA-SHA256", Buffer.from(data), this.credentials.VONAGE_PRIVATE_KEY).toString("base64url")}`;
  }
  async request<T>(path: string, method = "GET", body?: unknown): Promise<Result<T>> {
    try {
      const response = await fetch(`https://api.nexmo.com/v1${path}`, { method, headers: { authorization: `Bearer ${this.jwt()}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000), redirect: "error" });
      if (!response.ok) { const data = await response.json().catch(() => ({})) as Record<string, unknown>; return { ok: false, error: `Vonage HTTP ${response.status}: ${String(data.title ?? data.error_title ?? data.detail ?? "request failed").slice(0, 300)}` }; }
      return { ok: true, value: response.status === 204 ? {} as T : await response.json() as T };
    } catch { return { ok: false, error: "Could not connect to Vonage" }; }
  }
  dial(to: string, ncco: unknown[], eventUrl: string) { return this.request<{ uuid: string; status: string }>("/calls", "POST", { to: [{ type: "phone", number: to.slice(1) }], from: { type: "phone", number: this.credentials.VONAGE_FROM_NUMBER.replace(/^\+/, "") }, ncco, event_url: [eventUrl], event_method: "POST" }); }
  async hangup(id: string): Promise<Result<unknown>> {
    const result = await this.request(`/calls/${encodeURIComponent(id)}`, "PUT", { action: "hangup" });
    if (result.ok) return result;
    const current = await this.request<{ status: string }>(`/calls/${encodeURIComponent(id)}`);
    if (current.ok && ["completed", "busy", "cancelled", "unanswered", "rejected", "failed", "timeout"].includes(current.value.status)) return { ok: true, value: { ended: true } };
    return result;
  }
}
export function signedWebhook(header: string | null, secret: string, now = Date.now(), rawBody?: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  try {
    const parts = header.slice(7).split("."); if (parts.length !== 3) return false;
    const [h, p, s] = parts as [string, string, string];
    const meta = JSON.parse(Buffer.from(h, "base64url").toString());
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    if (meta.alg !== "HS256" || !Number.isFinite(payload.iat) || Math.abs(now / 1000 - payload.iat) > 300 || (payload.exp !== undefined && payload.exp < now / 1000)) return false;
    if (rawBody !== undefined && payload.payload_hash !== createHash("sha256").update(rawBody).digest("hex")) return false;
    const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest(); const actual = Buffer.from(s, "base64url");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}
