import { randomUUID } from "node:crypto";
import type { Model, ModelAuth, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Store } from "../store.js";
import type { SharedOAuthAuth } from "../auth/shared-oauth.js";
import { chooseInteractiveAccount } from "../auth/account-selection.js";
import { isRateLimitError, rateLimitCooldownMs } from "../provider-errors.js";
import { isCodexNotFoundError, repairProviderCredential } from "../auth/provider-rejection.js";
import { recordModelUsage } from "./usage-logger.js";

export const PROVIDER_OPERATION_EVENT = "pi-stack:provider-operation";
export type OperationResult<T = unknown> = ({ ok: true; value: T } | { ok: false; error: string }) & { usage?: Usage };
export interface ProviderOperation {
  model: Model<any>;
  signal: AbortSignal;
  sessionId: string;
  purpose: "compaction";
  run(model: Model<any>, options?: ModelAuth & { signal: AbortSignal }): Promise<OperationResult>;
  handled: boolean;
  resolve(result: OperationResult): void;
}

export async function runProviderOperation(
  request: ProviderOperation,
  store: Store,
  auth: SharedOAuthAuth,
  signal: AbortSignal,
  onRoute?: (model: Model<any>) => Promise<void>,
): Promise<OperationResult> {
  const family = store.account(request.model.provider)!.provider;
  const excluded = new Set<string>();
  const runId = process.env.PI_ORCHESTRATOR_RUN_ID;
  const parentLease = runId ? `run:${runId}` : `interactive:${request.sessionId}`;
  let account = request.model.provider;
  let last: OperationResult = { ok: false, error: "No account available for provider operation" };
  while (!signal.aborted && excluded.size < 3) {
    const lease = store.activeLeases(account).some(entry => entry.id === parentLease) ? undefined : `operation:${randomUUID()}`;
    let timer: ReturnType<typeof setInterval> | undefined;
    let repairDetail: string | undefined;
    try {
      if (lease) {
        store.createLease(lease, account, runId ? "fleet" : "interactive", runId);
        timer = setInterval(() => store.heartbeatLease(lease), 30_000);
      }
      const model = { ...request.model, provider: account };
      for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
        const credential = await auth.resolve(account, signal);
        last = await request.run(model, { ...credential, signal });
        if (!last.ok && repairDetail) last = { ...last, error: `${repairDetail}; after shared OAuth repair: ${last.error}` };
        if (last.usage) recordModelUsage(store, account, model.id, last.usage, request.sessionId);
        if (last.ok || attempt !== 0 || !credential.apiKey) break;
        const repair = await repairProviderCredential(auth, account, last.error,
          family === "openai-codex" && !last.usage?.totalTokens && isCodexNotFoundError(last.error, model), signal, credential.apiKey);
        if (repair.outcome !== "repaired") {
          last = { ...last, error: repair.detail };
          break;
        }
        repairDetail = repair.detail;
      }
      if (signal.aborted) return { ok: false, error: signal.reason?.message ?? "Provider operation aborted", usage: last.usage };
      if (last.ok) {
        if (account !== request.model.provider && onRoute) {
          await onRoute(model);
        }
        return last;
      }
      if (!isRateLimitError(last.error)) return last;
      store.setCooldown(account, Date.now() + rateLimitCooldownMs(last.error));
      if (process.env.PI_ORCHESTRATOR_ASSIGNED === "1") return last;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, error: repairDetail ? `${repairDetail}; after shared OAuth repair: ${detail}` : detail };
    } finally {
      if (timer) clearInterval(timer);
      if (lease) store.endLease(lease);
    }
    excluded.add(account);
    const next = chooseInteractiveAccount(store, auth, family, excluded);
    if (!next) return last;
    account = next.id;
  }
  return signal.aborted ? { ok: false, error: "Provider operation aborted" } : last;
}

export function installProviderOperations(pi: ExtensionAPI, store: Store, shared: Map<string, SharedOAuthAuth>): void {
  const shutdown = new AbortController();
  const pending = new Set<Promise<void>>();
  const unsubscribe = pi.events.on(PROVIDER_OPERATION_EVENT, (raw: unknown) => {
    const request = raw as ProviderOperation;
    if (request.handled) return;
    request.handled = true;
    const operation = Promise.resolve().then(() => {
      const signal = AbortSignal.any([request.signal, shutdown.signal]);
      const family = store.account(request.model.provider)?.provider;
      const auth = family ? shared.get(family) : undefined;
      return auth ? runProviderOperation(request, store, auth, signal, async model => {
        const thinking = pi.getThinkingLevel();
        if (!await pi.setModel(model)) throw new Error(`Cannot select provider operation account ${model.provider}`);
        pi.setThinkingLevel(thinking);
      }) : request.run(request.model, { signal });
    })
      .then(request.resolve, error => request.resolve({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => pending.delete(operation));
    pending.add(operation);
  });
  pi.on("session_shutdown", async () => {
    unsubscribe();
    shutdown.abort(new Error("Provider operation stopped by session shutdown"));
    await Promise.all(pending);
  });
}
