export type SubscriptionCredentialError = {
  code: "metered_inference_forbidden" | "subscription_credential_unset" | "subscription_credential_invalid";
  message: string;
};
export type SubscriptionCredentialResult<T> = { ok: true; value: T } | { ok: false; error: SubscriptionCredentialError };

export function subscriptionCredential<T>(family: string, value: unknown, decode: (value: unknown) => T | undefined): SubscriptionCredentialResult<T> {
  if (family !== "openai-codex" && family !== "anthropic") return { ok: false, error: { code: "metered_inference_forbidden", message: "Inference requires the shared subscription pool; this provider is not a subscription route." } };
  if (value === undefined) return { ok: false, error: { code: "subscription_credential_unset", message: "Shared subscription credential is unset; repair the pool. API fallback is forbidden." } };
  if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "oauth") return { ok: false, error: { code: "metered_inference_forbidden", message: "Non-OAuth inference credentials are forbidden. Use the shared subscription pool." } };
  const decoded = decode(value);
  return decoded === undefined ? { ok: false, error: { code: "subscription_credential_invalid", message: "Shared subscription credential is invalid; repair it without API fallback." } } : { ok: true, value: decoded };
}

// Provider adapters are an exception-throwing foreign boundary.
export function subscriptionBoundaryError(error: SubscriptionCredentialError): Error & { code: SubscriptionCredentialError["code"] } {
  return Object.assign(new Error(error.message), { code: error.code });
}
