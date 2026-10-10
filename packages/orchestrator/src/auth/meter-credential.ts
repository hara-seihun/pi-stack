import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { SharedOAuthAuth } from "./shared-oauth.js";

export type MeterCredential =
  | { ok: true; credential: OAuthCredential }
  | { ok: false; outcome: "no-credential" | "credential-failed" | "cancelled"; detail?: string };

export function meterRequestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
}

export async function meterCredential(auth: SharedOAuthAuth, accountId: string, timeoutMs: number, signal?: AbortSignal): Promise<MeterCredential> {
  try {
    signal?.throwIfAborted();
    if (!auth.hasCredential(accountId)) return { ok: false, outcome: "no-credential" };
    const credential = await auth.credential(accountId, meterRequestSignal(timeoutMs, signal), undefined, AbortSignal.timeout(timeoutMs));
    signal?.throwIfAborted();
    return { ok: true, credential };
  } catch (error) {
    return { ok: false, outcome: signal?.aborted ? "cancelled" : "credential-failed", detail: String(error) };
  }
}
