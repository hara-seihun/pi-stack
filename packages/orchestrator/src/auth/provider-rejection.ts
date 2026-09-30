import type { Model } from "@earendil-works/pi-ai";
import { CodexUnauthorizedError, fetchCodexUsage } from "../meters-codex.js";
import { isRejectedTokenError } from "../provider-errors.js";
import type { SharedOAuthAuth } from "./shared-oauth.js";

export function isCodexNotFoundError(message: string, model: Pick<Model<any>, "api" | "baseUrl">): boolean {
  if (model.api !== "openai-codex-responses" || !/^(?:HTTP 404[: ]*|404[: ]*)?Not Found$/i.test(message.trim())) return false;
  return model.baseUrl !== undefined && /^https:\/\/chatgpt\.com\/backend-api(?:\/codex(?:\/responses)?)?\/*$/.test(model.baseUrl);
}

export async function providerResponseFailure(response: Response): Promise<string> {
  if (response.ok) return "";
  let detail: string;
  try { detail = (await response.clone().text()).slice(0, 2000); }
  catch { detail = "error response body unavailable"; }
  return `HTTP ${response.status}: ${detail}`;
}

/** A second rejection exhausts the repair budget, not another refresh grant. */
export async function quarantineProviderCredential(
  auth: SharedOAuthAuth, account: string, message: string, codexNotFound: boolean,
  signal: AbortSignal, access?: string, usage = fetchCodexUsage,
): Promise<void> {
  if (!access || (!isRejectedTokenError(message) && !codexNotFound)) return;
  if (!isRejectedTokenError(message)) {
    const current = await auth.credential(account, signal, 0);
    if (typeof current.accountId !== "string" || !current.accountId) return;
    try { await usage(access, current.accountId, undefined, 10_000, Date.now(), signal); return; }
    catch (error) { if (!(error instanceof CodexUnauthorizedError)) return; }
  }
  await auth.reject(account, access, signal);
}

export type CredentialRepair =
  | { outcome: "repaired"; detail: string }
  | { outcome: "not-rejected"; detail: string }
  | { outcome: "failed"; detail: string };

/** Callers own the one-repair budget. Only the fixed usage route can corroborate an ambiguous inference 404. */
export async function repairProviderCredential(
  auth: SharedOAuthAuth,
  account: string,
  message: string,
  codexNotFound: boolean,
  signal: AbortSignal,
  rejectedAccessToken?: string,
  usage = fetchCodexUsage,
): Promise<CredentialRepair> {
  if (!isRejectedTokenError(message) && !codexNotFound) return { outcome: "not-rejected", detail: message };
  let detail = message;
  try {
    if (isRejectedTokenError(message) && rejectedAccessToken) {
      await auth.refreshRejected(account, rejectedAccessToken, signal);
      return { outcome: "repaired", detail };
    }
    const current = await auth.credential(account, signal, 0);
    const rejected = rejectedAccessToken ?? current.access;
    if (codexNotFound && !isRejectedTokenError(message)) {
      if (typeof current.accountId !== "string" || !current.accountId) {
        return { outcome: "failed", detail: `${message}; credential check failed: missing ChatGPT account id` };
      }
      try {
        await usage(rejected, current.accountId, undefined, 10_000, Date.now(), signal);
        return { outcome: "not-rejected", detail: `${message}; Codex usage accepted the credential; no refresh attempted` };
      } catch (error) {
        if (!(error instanceof CodexUnauthorizedError)) {
          return { outcome: "failed", detail: `${message}; credential check failed: ${String(error)}` };
        }
        detail = `${message}; credential rejection corroborated by ${error.message}`;
      }
    }
    await auth.refreshRejected(account, rejected, signal);
    return { outcome: "repaired", detail };
  } catch (error) {
    return { outcome: "failed", detail: `${detail}; shared OAuth repair failed: ${String(error)}` };
  }
}
