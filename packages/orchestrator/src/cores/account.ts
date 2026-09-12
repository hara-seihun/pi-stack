import { homedir } from "node:os";
import { join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { chooseInteractiveAccount } from "../auth/account-selection.js";
import { defaultSharedAuthPath, providerOAuth, type SharedOAuthAuth } from "../auth/shared-oauth.js";
import { allowsAccountUse } from "../domain.js";
import { Store } from "../store.js";

const CODEX_PROVIDER = "openai-codex";
const DEFAULT_HEARTBEAT_MS = 30_000;

export interface CoreAccountOptions {
  readonly initialProvider: string;
  readonly initialModel: string;
  readonly sessionId: string;
  readonly env: Record<string, string | undefined>;
  readonly ledgerPath?: string;
  readonly authPath?: string;
  readonly heartbeatMs?: number;
  readonly auth?: SharedOAuthAuth;
}

export interface CoreAccountCredentials {
  readonly accessToken: string;
  readonly chatgptAccountId: string;
  readonly chatgptPlanType?: string;
}

export interface CoreAccountCredentialRequest {
  readonly refresh?: boolean;
  readonly previousAccountId?: string | null;
  readonly signal?: AbortSignal;
}

/** Cumulative counters from one native Codex thread. */
export interface CoreAccountUsage {
  readonly sessionId: string;
  readonly nativeThreadId: string;
  readonly turnId: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens?: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens?: number;
  readonly totalTokens: number;
}

export interface CoreAccount {
  readonly accountId: string;
  readonly provider: string;
  readonly model: string;
  credentials(request?: CoreAccountCredentialRequest): Promise<CoreAccountCredentials>;
  recordUsage(usage: CoreAccountUsage): void;
  close(): Promise<void>;
}

type UsageCounters = Pick<CoreAccountUsage,
  "inputTokens" | "cachedInputTokens" | "cacheWriteInputTokens" | "outputTokens" | "totalTokens"
>;

function accountFamily(store: Store, provider: string): string {
  return store.account(provider)?.provider ?? provider.replace(/-\d+$/u, "");
}

function eligibleRequestedAccount(store: Store, auth: SharedOAuthAuth, provider: string) {
  const account = store.account(provider);
  return account
    && allowsAccountUse(account, "interactive")
    && (!account.cooldownUntil || account.cooldownUntil <= Date.now())
    && auth.has(account.id)
    ? account
    : undefined;
}

function codexAuth(path: string): SharedOAuthAuth {
  const provider = builtinProviders().find(candidate => candidate.id === CODEX_PROVIDER);
  if (!provider) throw new Error("The OpenAI Codex OAuth provider is unavailable");
  return providerOAuth(provider, path);
}

function nonnegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Codex usage ${field} must be a nonnegative integer`);
  return value;
}

function counters(usage: CoreAccountUsage): Required<UsageCounters> {
  const value = {
    inputTokens: nonnegativeInteger(usage.inputTokens, "inputTokens"),
    cachedInputTokens: nonnegativeInteger(usage.cachedInputTokens, "cachedInputTokens"),
    cacheWriteInputTokens: nonnegativeInteger(usage.cacheWriteInputTokens ?? 0, "cacheWriteInputTokens"),
    outputTokens: nonnegativeInteger(usage.outputTokens, "outputTokens"),
    totalTokens: nonnegativeInteger(usage.totalTokens, "totalTokens"),
  };
  if (value.cachedInputTokens + value.cacheWriteInputTokens > value.inputTokens) {
    throw new Error("Codex cached and cache-write input exceeds total input");
  }
  return value;
}

function optionalPlanType(credential: object): string | undefined {
  const raw = credential as Record<string, unknown>;
  for (const key of ["chatgptPlanType", "chatgpt_plan_type", "planType"]) {
    if (typeof raw[key] === "string" && raw[key] !== "") return raw[key];
  }
  return undefined;
}

function recordedCounters(store: Store, accountId: string, source: string, runId: string): Required<UsageCounters> {
  const rows = store.db.prepare(`SELECT component,SUM(tokens) tokens FROM usage_hour
    WHERE account_id=? AND source=? AND run_id=? GROUP BY component`).all(accountId, source, runId) as { component: string; tokens: number }[];
  const components = Object.fromEntries(rows.map(row => [row.component, Number(row.tokens)]));
  const inputTokens = (components.input ?? 0) + (components.cacheRead ?? 0) + (components.cacheWrite ?? 0);
  const outputTokens = components.output ?? 0;
  return {
    inputTokens,
    cachedInputTokens: components.cacheRead ?? 0,
    cacheWriteInputTokens: components.cacheWrite ?? 0,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

export async function openCoreAccount(options: CoreAccountOptions): Promise<CoreAccount> {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs > 2_147_483_647) {
    throw new Error("Core account heartbeatMs must be a positive 32-bit integer");
  }
  const home = options.env.HOME || homedir();
  const ledgerPath = options.ledgerPath
    ?? options.env.PI_ORCHESTRATOR_LEDGER
    ?? join(home, ".local/share/pi-orchestrator/ledger.sqlite3");
  const authPath = options.authPath
    ?? options.env.PI_ORCHESTRATOR_AUTH
    ?? defaultSharedAuthPath(ledgerPath);
  const store = Store.open(ledgerPath);
  const auth = options.auth ?? codexAuth(authPath);
  const assignedRunId = options.env.PI_ORCHESTRATOR_ASSIGNED === "1"
    ? options.env.PI_ORCHESTRATOR_RUN_ID
    : undefined;
  let openedLeaseId: string | undefined;

  try {
    if (options.env.PI_ORCHESTRATOR_ASSIGNED === "1" && !assignedRunId) {
      throw new Error("An assigned core requires PI_ORCHESTRATOR_RUN_ID");
    }

    const assigned = assignedRunId ? store.run(assignedRunId) : undefined;
    if (assignedRunId && (!assigned?.accountId || !assigned.provider || !assigned.model)) {
      throw new Error(`Assigned run ${assignedRunId} has no complete account assignment`);
    }

    const provider = assigned?.provider ?? accountFamily(store, options.initialProvider);
    const model = assigned?.model ?? options.initialModel;
    if (provider !== CODEX_PROVIDER) throw new Error(`External Codex cores require ${CODEX_PROVIDER}, not ${provider}`);

    const leaseId = assignedRunId ? `run:${assignedRunId}` : `interactive:${options.sessionId}`;
    const account = assigned
      ? store.account(assigned.accountId!)
      : store.transaction(() => {
          const selected = eligibleRequestedAccount(store, auth, options.initialProvider)
            ?? chooseInteractiveAccount(store, auth, provider);
          if (selected) store.createLease(leaseId, selected.id, "interactive");
          return selected;
        });
    if (!assignedRunId && account) openedLeaseId = leaseId;
    if (!account || account.provider !== provider || !auth.has(account.id)) {
      throw new Error(`No eligible shared ${provider} account is available`);
    }

    if (assignedRunId) {
      store.heartbeatLease(leaseId);
      if (!store.activeLeases(account.id).some(lease => lease.id === leaseId)) {
        throw new Error(`Assigned run ${assignedRunId} has no active account lease`);
      }
    }
    openedLeaseId = leaseId;

    let closed = false;
    let closePromise: Promise<void> | undefined;
    let lastAccessToken: string | undefined;
    const usageByThread = new Map<string, Required<UsageCounters>>();
    const lifecycle = new AbortController();
    const pendingCredentials = new Set<Promise<CoreAccountCredentials>>();
    const heartbeat = setInterval(() => store.heartbeatLease(leaseId), heartbeatMs);
    heartbeat.unref?.();

    const credentials = (request: CoreAccountCredentialRequest = {}): Promise<CoreAccountCredentials> => {
      if (closed) return Promise.reject(new Error("Core account is closed"));
      const signal = request.signal
        ? AbortSignal.any([lifecycle.signal, request.signal])
        : lifecycle.signal;
      const operation = (async () => {
        let credential = await auth.credential(account.id, signal);
        const accountId = typeof credential.accountId === "string" ? credential.accountId : undefined;
        if (!accountId) throw new Error(`${account.id} has no ChatGPT account identity`);
        if (request.previousAccountId && request.previousAccountId !== accountId) {
          throw new Error(`Codex requested credentials for another ChatGPT account`);
        }
        if (request.refresh) {
          credential = await auth.refreshRejected(account.id, lastAccessToken ?? credential.access, signal);
        }
        const refreshedAccountId = typeof credential.accountId === "string" ? credential.accountId : undefined;
        if (!refreshedAccountId) throw new Error(`${account.id} has no ChatGPT account identity`);
        lastAccessToken = credential.access;
        const chatgptPlanType = optionalPlanType(credential);
        return {
          accessToken: credential.access,
          chatgptAccountId: refreshedAccountId,
          ...(chatgptPlanType ? { chatgptPlanType } : {}),
        };
      })();
      pendingCredentials.add(operation);
      void operation.finally(() => pendingCredentials.delete(operation)).catch(() => {});
      return operation;
    };

    const recordUsage = (usage: CoreAccountUsage): void => {
      if (closed) throw new Error("Core account is closed");
      if (usage.sessionId !== options.sessionId) throw new Error("Codex usage belongs to another PiStack session");
      if (!usage.nativeThreadId || !usage.turnId || !usage.model) throw new Error("Codex usage requires native thread, turn, and model identities");
      const current = counters(usage);
      if (usage.reasoningOutputTokens !== undefined) nonnegativeInteger(usage.reasoningOutputTokens, "reasoningOutputTokens");
      const runId = assignedRunId ?? options.sessionId;
      const source = `${assignedRunId ? "fleet" : "interactive"}:core:${usage.nativeThreadId}`;
      const previous = usageByThread.get(usage.nativeThreadId)
        ?? recordedCounters(store, account.id, source, runId);
      for (const key of Object.keys(current) as (keyof Required<UsageCounters>)[]) {
        if (current[key] < previous[key]) throw new Error(`Codex cumulative usage regressed for ${key}`);
      }
      const deltas = {
        input: current.inputTokens - previous.inputTokens
          - (current.cachedInputTokens - previous.cachedInputTokens)
          - (current.cacheWriteInputTokens - previous.cacheWriteInputTokens),
        cacheRead: current.cachedInputTokens - previous.cachedInputTokens,
        cacheWrite: current.cacheWriteInputTokens - previous.cacheWriteInputTokens,
        output: current.outputTokens - previous.outputTokens,
      } as const;
      if (deltas.input < 0) throw new Error("Codex cumulative fresh input usage regressed");
      const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
      store.transaction(() => {
        for (const [component, tokens] of Object.entries(deltas)) {
          if (tokens > 0) store.recordUsage({
            accountId: account.id,
            hour,
            source,
            runId,
            model: usage.model,
            component: component as "input" | "output" | "cacheRead" | "cacheWrite",
            tokens,
          });
        }
      });
      usageByThread.set(usage.nativeThreadId, current);
    };

    const close = (): Promise<void> => {
      if (closePromise) return closePromise;
      closed = true;
      clearInterval(heartbeat);
      lifecycle.abort(new Error("Core account closed"));
      closePromise = (async () => {
        await Promise.allSettled([...pendingCredentials]);
        store.endLease(leaseId);
        store.close();
        lastAccessToken = undefined;
        usageByThread.clear();
      })();
      return closePromise;
    };

    return { accountId: account.id, provider, model, credentials, recordUsage, close };
  } catch (error) {
    if (openedLeaseId) store.endLease(openedLeaseId);
    store.close();
    throw error;
  }
}
