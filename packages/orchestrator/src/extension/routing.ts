import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Ledger } from "../ledger/ledger.js";
import {
  defaultSharedCodexAuthPath,
  SharedCodexAuth,
  sharedCodexProvider,
} from "../auth/shared-codex.js";
import { pickAccount } from "./select-account.js";
import { baseProvider, defaultLedgerPath } from "./usage-logger.js";

/**
 * The multi-pass successor: multi-account routing for interactive pi
 * sessions, driven entirely by the orchestrator ledger.
 *
 * - Exclusive aliases delegate models, transport, and OAuth to their builtin
 *   family and use the owning user's auth.json. Shared Codex accounts use the
 *   central credential store beside the ledger, including the unsuffixed
 *   family id. The account table is the only registry.
 * - At session start the session binds to the least-used account of its
 *   model's family (round-robin among ties) and then stays sticky: provider
 *   prompt caches are per-account, so rebinding mid-session wastes them.
 * - On a rate-limit error the failing account cools down in the ledger
 *   (which broker admission also honours) and the session moves to the next
 *   account. Stickiness yields only to failure. pi's own auto-retry then
 *   replays the interrupted turn on the account we just moved to, so the
 *   resume prompt is held back until `agent_settled` proves no retry
 *   rescued the turn — an injected "your turn did not complete" after a
 *   completed reply is a lie the agent has to reason around.
 *
 * Orchestrator-launched sessions set PI_ORCHESTRATOR_ASSIGNED=1: the broker
 * owns their account custody, so binding and failover stay out — one brain
 * per decision. Alias provider registration still happens there, because it
 * is credential plumbing, not a routing decision, and broker-assigned aliases
 * must resolve.
 */

export { isRateLimitError } from "../rate-limit.js";
import { isRateLimitError, rateLimitCooldownMs } from "../rate-limit.js";

/** An alias provider: the family's models, transport, and OAuth under the
 * account's own id, so credentials resolve from auth.json[aliasId]. */
export function aliasProvider(family: Provider, aliasId: string, label?: string): Provider {
  return {
    id: aliasId,
    name: label !== undefined ? `${family.name} [${label}]` : `${family.name} [${aliasId}]`,
    baseUrl: family.baseUrl,
    headers: family.headers,
    auth: family.auth,
    getModels: () =>
      family.getModels().map((m) => ({ ...m, provider: aliasId, name: `${m.name} (${aliasId})` })),
    filterModels: family.filterModels?.bind(family),
    stream: (model, context, options) => family.stream(model as never, context, options),
    streamSimple: (model, context, options) => family.streamSimple(model, context, options),
  };
}

export function failoverPrompt(failure: string, account: string): string {
  return (
    `## Provider failover\n\nYour previous turn did not complete: ${failure.slice(0, 500)}\n\n` +
    `This session moved to another account (${account}). Nothing was lost: your reasoning, ` +
    `tool calls, and tool results above are all still here. Continue exactly where you ` +
    `stopped rather than restarting, and verify any tool call whose result you never saw.`
  );
}

export default function routing(pi: ExtensionAPI): void {
  const ledgerPath = defaultLedgerPath();
  const ledger = Ledger.open(ledgerPath);
  const families = new Map(builtinProviders().map((p) => [p.id, p]));
  const codex = families.get("openai-codex")?.auth.oauth;
  const sharedAuth = codex === undefined
    ? undefined
    : new SharedCodexAuth({
        path: defaultSharedCodexAuthPath(ledgerPath),
        refresh: (credential, signal) => codex.refresh(credential, signal),
        toAuth: (credential) => codex.toAuth(credential),
      });

  const domain = process.env.PI_ORCHESTRATOR_ASSIGNED === "1" ? "orchestrator" : "interactive";
  for (const account of ledger.accounts()) {
    if (!account.shared && account.id === account.provider) continue;
    if (!account.shared && account.domain !== domain) continue;
    const family = families.get(account.provider);
    if (family === undefined) continue;
    if (account.shared) {
      if (account.provider !== "openai-codex" || sharedAuth === undefined) {
        console.error(`pi-orchestrator: shared auth is unavailable for ${account.id}`);
        continue;
      }
      pi.registerProvider(sharedCodexProvider(family, account.id, account.label, sharedAuth));
    } else {
      pi.registerProvider(aliasProvider(family, account.id, account.label));
    }
  }

  if (process.env.PI_ORCHESTRATOR_ASSIGNED === "1") {
    pi.on("session_shutdown", async () => {
      ledger.close();
    });
    return;
  }

  /** The family model re-homed onto an account's alias provider. */
  const resolve = (accountId: string, family: string, modelId: string): Model<never> | undefined => {
    const model = families.get(family)?.getModels().find((m) => m.id === modelId);
    if (model === undefined) return undefined;
    return (accountId === family ? model : { ...model, provider: accountId }) as Model<never>;
  };

  const familyOf = (providerAlias: string): string =>
    ledger.accounts().find((a) => a.id === providerAlias)?.provider ?? baseProvider(providerAlias);

  /** Binds the session to the best account of the current model's family.
   * Returns the chosen account id when a switch happened. */
  const bind = async (
    ctx: ExtensionContext,
    exclude?: ReadonlySet<string>,
  ): Promise<string | undefined> => {
    const current = ctx.model;
    if (current === undefined) return undefined;
    const now = Date.now();
    const family = familyOf(current.provider);
    const choice = pickAccount(ledger.accounts(), family, now, (id) => ledger.latestUsedPercent(id), exclude);
    if (choice === undefined) return undefined;
    ledger.setAccountLastBound(choice.id, now);
    if (choice.id === current.provider) return undefined;
    const next = resolve(choice.id, family, current.id);
    if (next === undefined) return undefined;
    return (await pi.setModel(next)) ? choice.id : undefined;
  };

  pi.on("session_start", async (event, ctx) => {
    // Only fresh sessions bind; resume/fork/reload stay sticky to their
    // account so provider caches survive.
    if (event.reason !== "startup" && event.reason !== "new") return;
    await bind(ctx);
  });

  /** A move that still owes the agent an explanation, if the run stays dead.
   * Only the most recent agent_end's verdict counts: a later successful run
   * (pi's auto-retry on the new account) clears it, and a later failure
   * replaces it. */
  let unresolved: { failure: string; account: string } | undefined;

  pi.on("agent_end", async (event, ctx) => {
    unresolved = undefined;
    const last = event.messages[event.messages.length - 1];
    if (last?.role !== "assistant") return;
    const { stopReason, errorMessage } = last as { stopReason?: string; errorMessage?: string };
    if (stopReason !== "error" || errorMessage === undefined) return;
    if (!isRateLimitError(errorMessage)) return;
    const failing = ctx.model?.provider;
    if (failing === undefined) return;
    if (ledger.accounts().some((a) => a.id === failing)) {
      ledger.setAccountCooldown(failing, Date.now() + rateLimitCooldownMs(errorMessage));
    }
    // Move now, before pi's auto-retry fires: the retry inherits the new
    // account, which is what usually saves the turn without the agent ever
    // knowing a provider fell over.
    const moved = await bind(ctx, new Set([failing]));
    if (moved !== undefined) unresolved = { failure: errorMessage, account: moved };
  });

  // agent_settled means pi will not retry, compact, or continue on its own.
  // Only here is the turn genuinely lost, so only here does the agent need
  // to be told to resume it.
  pi.on("agent_settled", async () => {
    const notice = unresolved;
    unresolved = undefined;
    if (notice === undefined) return;
    pi.sendUserMessage(failoverPrompt(notice.failure, notice.account));
  });

  pi.on("session_shutdown", async () => {
    ledger.close();
  });
}
