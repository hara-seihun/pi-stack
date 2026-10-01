import type { Provider, StreamOptions } from "@earendil-works/pi-ai";
import type { Store } from "../store.js";
import type { SharedOAuthAuth } from "./shared-oauth.js";
import { requireCodexTier } from "./codex-capabilities.js";

/** Guard the final wire payload, after extension hooks, before either transport sends it. */
export function withCodexTierGuard(provider: Provider, store: Store, auth: SharedOAuthAuth, accountId: string): Provider {
  const guarded = <T extends StreamOptions>(options?: T): T => ({ 
    ...options,
    async onPayload(payload: unknown, model: Parameters<NonNullable<StreamOptions["onPayload"]>>[1]) {
      const body = await options?.onPayload?.(payload, model) ?? payload;
      const tier = body && typeof body === "object" ? (body as { service_tier?: unknown }).service_tier : undefined;
      if (tier === "ultrafast") {
        const allowed = await requireCodexTier(store, auth, accountId, model.id, tier, options?.signal);
        if (!allowed.ok) throw new Error(allowed.error);
      }
      return body;
    },
  }) as T;
  return {
    ...provider,
    stream: (model, context, options) => provider.stream(model, context, guarded(options)),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, guarded(options)),
  };
}
