import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { SharedOAuthAuth } from "./shared-oauth.js";

export type MeterCredential =
  | { ok: true; credential: OAuthCredential }
  | { ok: false; outcome: "no-credential" | "credential-failed"; detail?: string };

export async function meterCredential(auth: SharedOAuthAuth, accountId: string, timeoutMs: number): Promise<MeterCredential> {
  try {
    if (!auth.has(accountId)) return { ok: false, outcome: "no-credential" };
    const credential = await auth.credential(accountId, AbortSignal.timeout(timeoutMs));
    return { ok: true, credential };
  } catch (error) {
    return { ok: false, outcome: "credential-failed", detail: String(error) };
  }
}
