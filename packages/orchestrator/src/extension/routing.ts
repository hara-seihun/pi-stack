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
import { credentialedAccountIds } from "../auth/credentials.js";
import { homedir } from "node:os";
import { join } from "node:path";

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

export { isRateLimitError } from "../provider-errors.js";
import { isRateLimitError } from "../provider-errors.js";
import { cooldownPolicy, loadConfig } from "../config.js";
import { interruptedTurnPrompt } from "../host/continuations.js";

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
  return interruptedTurnPrompt(
    failure,
    `This session moved to another account (${account}) and is ready to keep going.`,
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

  // Which accounts this runtime may spend is exactly which credentials its
  // own auth store holds — re-read per use, so a login mid-session is seen.
  const authStorePath = join(
    process.env.PI_AGENT_DIR ??
      process.env.PI_CODING_AGENT_DIR ??
      join(homedir(), ".pi", "agent"),
    "auth.json",
  );
  const held = (accountId: string): boolean =>
    credentialedAccountIds([authStorePath]).has(accountId);
  for (const account of ledger.accounts()) {
    if (!account.shared && account.id === account.provider) continue;
    if (!account.shared && !held(account.id)) continue;
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

  // Only interactive failover cools accounts down here, so only interactive
  // sessions need the operator's limit topology; a broken config is a broken
  // deployment and says so rather than quietly routing on default classes.
  const cooldown = cooldownPolicy(loadConfig());

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
    requested?: { family: string; modelId: string },
  ): Promise<string | undefined> => {
    const current = ctx.model;
    let family: string;
    let modelId: string;
    if (requested !== undefined) {
      family = requested.family;
      modelId = requested.modelId;
    } else {
      if (current === undefined) return undefined;
      family = familyOf(current.provider);
      modelId = current.id;
    }
    const now = Date.now();
    const choice = pickAccount(ledger.accounts(), family, now, (id) => ledger.latestUsedPercent(id), held, exclude);
    if (choice === undefined) return undefined;
    ledger.setAccountLastBound(choice.id, now);
    if (choice.id === current?.provider && modelId === current.id) return undefined;
    const next = resolve(choice.id, family, modelId);
    if (next === undefined) return undefined;
    await ctx.modelRegistry.refresh({ providers: [choice.id], allowNetwork: false });
    return (await pi.setModel(next)) ? choice.id : undefined;
  };

  pi.on("session_start", async (event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const hasAssistantHistory = branch.some(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
    if (hasAssistantHistory) {
      // Pi chooses its startup model before extension providers are registered.
      // The transcript's explicit selections remain the user's intent; unlike
      // assistant metadata, they are not changed by Pi's startup fallback.
      let selected: { provider: string; modelId: string } | undefined;
      for (const entry of branch) {
        if (entry.type === "model_change") {
          selected = { provider: entry.provider, modelId: entry.modelId };
        }
      }
      if (selected === undefined) return;
      if (ctx.model?.provider === selected.provider && ctx.model.id === selected.modelId) return;

      const family = familyOf(selected.provider);
      const saved = resolve(selected.provider, family, selected.modelId);
      await ctx.modelRegistry.refresh({ providers: [selected.provider], allowNetwork: false });
      if (saved !== undefined && await pi.setModel(saved)) return;
      await bind(ctx, undefined, { family, modelId: selected.modelId });
      return;
    }

    // Only fresh sessions bind; resumed sessions restore above, while reloads
    // with no assistant history leave the current selection untouched.
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
      ledger.setAccountCooldown(failing, Date.now() + cooldown(familyOf(failing), errorMessage));
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
