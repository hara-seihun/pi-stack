import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
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
import { Delegator } from "../host/delegation.js";
import { nestedSession } from "../host/session-context.js";

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
  const delegator = new Delegator(ledger, {
    agentDir:
      process.env.PI_AGENT_DIR ??
      process.env.PI_CODING_AGENT_DIR ??
      join(homedir(), ".pi", "agent"),
  });
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Run one well-scoped task in an isolated nested Pi session and return only its final answer. " +
      "The nested agent inherits this session's model, reasoning level, tools, project guidance, and " +
      "working directory unless cwd is supplied. It cannot see this conversation, so include all context " +
      "it needs in task. Calls from this session run one at a time and cancellation follows the parent turn.",
    promptSnippet: "Delegate one isolated task to a nested agent and receive its final answer",
    promptGuidelines: [
      "Use delegate for a self-contained investigation or implementation that benefits from an isolated context; write a complete task because the nested agent cannot see this conversation.",
    ],
    parameters: Type.Object({
      task: Type.String({ minLength: 1, description: "Complete, self-contained task for the nested agent." }),
      cwd: Type.Optional(
        Type.String({ description: "Working directory for the nested agent. Relative paths resolve from the current cwd." }),
      ),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      if (ctx.model === undefined) throw new Error("delegate requires an active model");
      const answer = await delegator.run(
        params,
        {
          cwd: ctx.cwd,
          model: ctx.model as Model<any>,
          thinkingLevel: ctx.thinkingLevel,
          tools: pi.getActiveTools(),
          sessionId: ctx.sessionManager.getSessionId(),
        },
        signal,
      );
      return {
        content: [{ type: "text" as const, text: answer.text }],
        details: { sessionId: answer.sessionId },
        ...(answer.usage === undefined ? {} : { usage: answer.usage }),
      };
    },
  });
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
  ): Promise<string | undefined> => {
    const current = ctx.model;
    if (current === undefined) return undefined;
    const now = Date.now();
    const family = familyOf(current.provider);
    const choice = pickAccount(ledger.accounts(), family, now, (id) => ledger.latestUsedPercent(id), held, exclude);
    if (choice === undefined) return undefined;
    ledger.setAccountLastBound(choice.id, now);
    if (choice.id === current.provider) return undefined;
    const next = resolve(choice.id, family, current.id);
    if (next === undefined) return undefined;
    return (await pi.setModel(next)) ? choice.id : undefined;
  };

  pi.on("session_start", async (event, ctx) => {
    // A delegated child inherits the parent's exact model/account choice.
    // Re-running interactive selection here would create a second reservation
    // and throw away the parent's provider cache while it waits on this tool.
    if (nestedSession(ctx.sessionManager.getSessionId()) !== undefined) return;
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
    if (nestedSession(ctx.sessionManager.getSessionId()) !== undefined) return;
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
