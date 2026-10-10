import { createHash, randomUUID } from "node:crypto";
import { allowanceRefusal, BROKER_USAGE_PATH, brokerUsageAcrossStores, WeeklyAllowances } from "./broker-usage.js";
import { weekResetsAt } from "./person-usage.js";
import { zstdDecompressSync } from "node:zlib";
import { once } from "node:events";
import { readFileSync, statSync, unwatchFile, watchFile } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createParser } from "eventsource-parser";
import { Store } from "./store.js";
import { CompletionService, completionModel } from "./completion.js";
import { COMPLETION_OPENAPI } from "./completion-openapi.js";
import type { CompletionOutcome, CompletionRecord } from "./completion-contract.js";
import type { ProviderController } from "./provider-controller.js";
import { completionHttpStatus, isCompletionInput, isCompletionRequestId } from "./completion-contract.js";
import { modelDrainsMeter } from "./catalog.js";
import { allowsAccountUse, type UsageComponent } from "./domain.js";
import { imageAuth } from "./image-service.js";
import { chooseInteractiveAccount, eligibleInteractiveAccounts } from "./auth/account-selection.js";
import { accountModelExcluded, noEntitledAccountError, recordAccountModelUnsupported } from "./auth/model-entitlement.js";
import { codexTierExclusions } from "./auth/codex-capabilities.js";
import { modelSpeedModes } from "./threads/speed.js";
import { providerOAuth } from "./auth/shared-oauth.js";
import { repairProviderCredential, providerResponseFailure, quarantineProviderCredential } from "./auth/provider-rejection.js";
import { isRejectedTokenError } from "./provider-errors.js";
import { BROKER_ROUTES, validateBrokerBody, type BrokerFamily } from "./model-broker-contract.js";
import { anthropicMeterReadings } from "./extension/usage-logger.js";
import { forwardVoiceRequest } from "./voice-broker.js";
import { attachMeetRecognitionBroker } from "./meet-recognition-broker.js";
import { ModelAvailabilityStore, modelAvailabilityPath, sharedModelRefusal, type SharedModelRefusal } from "./threads/model-availability.js";

export interface BrokerListener {
  principal: string;
  port: number;
  accounts: string[];
  models: string[];
  maxInFlight: number;
  /** Most this principal may spend in any trailing seven days, in subscription dollars. */
  weeklyUsd?: number;
}
export interface ModelBrokerConfig {
  ledgerPath: string;
  authPath: string;
  listeners: BrokerListener[];
  grantOwner?: string;
}
export function validateBrokerConfig(value: unknown): value is ModelBrokerConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as ModelBrokerConfig;
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.length > 0 && items.every(item => typeof item === "string" && item.length > 0);
  return typeof config.ledgerPath === "string" && config.ledgerPath.startsWith("/")
    && typeof config.authPath === "string" && config.authPath.startsWith("/")
    && (config.grantOwner === undefined || typeof config.grantOwner === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(config.grantOwner))
    && Array.isArray(config.listeners) && config.listeners.length > 0
    && config.listeners.every(listener => listener && /^[a-z_][a-z0-9_-]*$/.test(listener.principal)
      && Number.isInteger(listener.port) && listener.port > 1023 && listener.port <= 65535
      && strings(listener.accounts) && strings(listener.models)
      && listener.models.every(model => /^(openai-codex|anthropic)\/[^/]+$/.test(model))
      && Number.isInteger(listener.maxInFlight) && listener.maxInFlight > 0
      && (listener.weeklyUsd === undefined || (typeof listener.weeklyUsd === "number" && Number.isFinite(listener.weeklyUsd) && listener.weeklyUsd >= 0)))
    && new Set(config.listeners.map(listener => listener.port)).size === config.listeners.length
    && new Set(config.listeners.map(listener => listener.principal)).size === config.listeners.length;
}

const MAX_BODY = 64 * 1024 * 1024;
const scoped = (principal: string, value: unknown) => createHash("sha256").update(`${principal}\0${String(value ?? "")}`).digest("hex");
const json = (res: ServerResponse, status: number, error: string) => {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: error, type: "model_broker_error" } }));
};

const refuseModel = (res: ServerResponse, refusal: SharedModelRefusal) => {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(completionHttpStatus(refusal.code), { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { ...refusal, type: "model_broker_error" } }));
};

interface DispatchReceipt {
  id: string; requestId: string; principal: string; accountId: string; model: string;
  serviceTier: string; at: number; updatedAt: number; httpStatus?: number;
  outcome: "dispatched" | "accepted" | "rejected" | "completed" | "incomplete" | "failed" | "cancelled" | "indeterminate";
}
const dispatchKey = (principal: string) => `broker-dispatches:${principal}`;

export type BrokerTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface RetainedCompletionOwner {
  id: string;
  store: Store;
  controller?: ProviderController;
}
interface CompletionAlias { state: "adopting" | "ready"; ownerId: string; requestId: string }
export type BrokerRequestAuthorization = { ok: true } | { ok: false; status: 403 | 503; message: string };
export type BrokerRequestAuthority = (principal: string, request: IncomingMessage) => Promise<BrokerRequestAuthorization>;
export interface EmbeddedBrokerOptions {
  store: Store;
  authorizeRequest?: BrokerRequestAuthority;
  /** Core publishes complete original owner partitions with their exact footprints. */
  grantPublication?: { kind: "borrowed" };
  controller?: ProviderController;
  completionOwners?: readonly RetainedCompletionOwner[];
}
export function createModelBroker(config: ModelBrokerConfig, availability: ModelAvailabilityStore, transport: BrokerTransport = fetch, embedded?: EmbeddedBrokerOptions) {
  const store = embedded?.store ?? Store.open(config.ledgerPath);
  if (store.path !== config.ledgerPath) {
    const actual = statSync(store.path, { bigint: true }), configured = statSync(config.ledgerPath, { bigint: true });
    if (actual.dev !== configured.dev || actual.ino !== configured.ino) throw new Error("Broker store differs from its configured ledger custody");
  }
  if (embedded?.controller && embedded.controller.store !== store) throw new Error("Broker and provider controller must share one Store");
  // Grants are desired state the broker owns for every declared ledger consumer.
  // Reloading the grant file republishes them for retained and new completion custody.
  const grants = new Map(config.listeners.map(listener => [listener.principal, { accounts: listener.accounts, models: listener.models, weeklyUsd: listener.weeklyUsd }]));
  const completionOwners = new Map<string, { store: Store; service: CompletionService; controller?: ProviderController }>();
  completionOwners.set("current", { store, service: embedded?.controller?.completions ?? new CompletionService(store, process.cwd()), controller: embedded?.controller });
  for (const owner of embedded?.completionOwners ?? []) {
    if (!/^[A-Za-z0-9._-]+$/.test(owner.id) || completionOwners.has(owner.id) || [...completionOwners.values()].some(value => value.store.path === owner.store.path)) throw new Error("Retained completion owner must have a unique declared identity and ledger");
    if (owner.controller && owner.controller.store !== owner.store) throw new Error("Retained completion controller has different ledger custody");
    completionOwners.set(owner.id, { store: owner.store, service: owner.controller?.completions ?? new CompletionService(owner.store, process.cwd()), controller: owner.controller });
  }
  const allowanceLedgers = [...completionOwners.values()].map(owner => new WeeklyAllowances(owner.store));
  const allowances = { spent: (principal: string, maxAgeMs?: number) => allowanceLedgers.reduce((total, owner) => total + owner.spent(principal, maxAgeMs), 0) };
  const overAllowance = (principal: string) => {
    const weeklyUsd = grants.get(principal)!.weeklyUsd;
    if (weeklyUsd === undefined) return null;
    const used = allowances.spent(principal);
    return used >= weeklyUsd ? allowanceRefusal(weeklyUsd) : null;
  };
  const publish = () => {
    if (embedded?.grantPublication?.kind === "borrowed") return;
    for (const owner of completionOwners.values()) owner.store.publishBrokerGrants([...grants].map(([principal, grant]) => ({ principal, ...grant })), config.grantOwner);
  };
  const mappedOwner = (principal: string, requestId: string) => {
    const ownedId = `broker-${scoped(principal, requestId)}`;
    const encoded = store.control(`completion-alias:${ownedId}`);
    if (!encoded) return { id: ownedId, owner: completionOwners.get("current")! };
    const alias = JSON.parse(encoded) as CompletionAlias;
    const owner = completionOwners.get(alias.ownerId);
    if (alias.state !== "ready" || !owner || !isCompletionRequestId(alias.requestId)) return undefined;
    return { id: alias.requestId, owner };
  };
  const providers = new Map(builtinProviders().filter(provider => provider.id in BROKER_ROUTES).map(provider => [provider.id, provider]));
  const auth = new Map([...providers].map(([id, provider]) => [id, providerOAuth(provider, config.authPath)]));
  const active = new Set<Promise<void>>();
  const inflight = new Map<string, number>();
  const sticky = new Map<string, string>();
  const shutdown = new AbortController();
  const servers: Server[] = [];
  let draining = false;
  let closed: Promise<void> | undefined;
  let listening: Promise<number[]> | undefined;
  const dispatches = (principal: string): DispatchReceipt[] => JSON.parse(store.control(dispatchKey(principal)) ?? "[]");
  const saveDispatch = (receipt: DispatchReceipt) => {
    receipt.updatedAt = Date.now();
    store.setControl(dispatchKey(receipt.principal), JSON.stringify([
      ...dispatches(receipt.principal).filter(previous => previous.id !== receipt.id), receipt,
    ].sort((a, b) => a.at - b.at).slice(-128)));
  };

  const request = async (listener: BrokerListener, req: IncomingMessage, res: ServerResponse) => {
    const grant = grants.get(listener.principal)!;
    if (req.method === "GET" && req.url === "/v1/dispatches") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ dispatches: dispatches(listener.principal) }));
      return;
    }
    if (req.url?.startsWith("/v1/voice/")) {
      const count = inflight.get(listener.principal) ?? 0;
      if (count >= listener.maxInFlight) { json(res, 503, "Your shared request limit is full"); return; }
      inflight.set(listener.principal, count + 1);
      try {
        await forwardVoiceRequest(listener.principal, req, res, shutdown.signal, transport);
      } finally {
        inflight.set(listener.principal, (inflight.get(listener.principal) ?? 1) - 1);
      }
      return;
    }
    if (req.method === "GET" && req.url === BROKER_USAGE_PATH) {
      let body: string;
      try { body = JSON.stringify(brokerUsageAcrossStores([...completionOwners.values()].map(owner => owner.store), listener.principal, grant.accounts, Date.now(), grant.weeklyUsd === undefined ? null : { weeklyUsd: grant.weeklyUsd, usedUsd: allowances.spent(listener.principal, 0), resetsAt: new Date(weekResetsAt()).toISOString() })); }
      catch (error) { console.error(`Model broker usage failed for ${listener.principal}: ${error instanceof Error ? error.message : "unknown error"}`); json(res, 500, "Usage is unavailable"); return; }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    if (req.method === "GET" && req.url === "/v1/completions/openapi.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(COMPLETION_OPENAPI));
      return;
    }
    const completionRoute = /^\/v1\/completions\/([^/?]+)(\/(?:cancel|retry|attempts))?$/.exec(req.url ?? "");
    if (completionRoute) {
      const reply = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      const error = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
      let requestId: string;
      try { requestId = decodeURIComponent(completionRoute[1]!); }
      catch { return error(400, "invalid-request", "Invalid completion request ID encoding."); }
      if (!isCompletionRequestId(requestId)) return error(400, "invalid-request", "Invalid completion request ID.");
      const mapped = mappedOwner(listener.principal, requestId);
      if (!mapped) return error(503, "invalid-state", "Completion custody adoption is unfinished or its declared ledger owner is unavailable; reuse this ID after reconciliation.");
      const ownedId = mapped.id, completions = mapped.owner.service;
      const outcomeReply = (outcome: CompletionOutcome<CompletionRecord>, status = 200) => outcome.ok
        ? reply(status, { ...outcome.value, requestId })
        : error(completionHttpStatus(outcome.error.code), outcome.error.code, outcome.error.message);
      if (req.method === "GET" && completionRoute[2] === "/attempts") {
        const attempts = completions.attempts(ownedId);
        return attempts ? reply(200, { attempts }) : error(404, "not-found", "Completion not found.");
      }
      if (req.method === "POST" && completionRoute[2] === "/cancel") {
        const outcome = completions.cancel(ownedId);
        mapped.owner.controller?.tick();
        return outcomeReply(outcome);
      }
      if (req.method === "POST" && completionRoute[2] === "/retry") return outcomeReply(completions.retry(ownedId));
      if (req.method === "GET" && !completionRoute[2]) {
        const record = completions.get(ownedId);
        return record ? reply(200, { ...record, requestId }) : error(404, "not-found", "Completion not found.");
      }
      if (req.method !== "PUT" || completionRoute[2]) return error(405, "invalid-request", "Unsupported completion operation.");
      let input: unknown;
      try {
        let length = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) { length += chunk.length; if (length > MAX_BODY) return error(413, "invalid-request", "Completion request exceeds 64 MiB."); chunks.push(Buffer.from(chunk)); }
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { return error(400, "invalid-request", "Invalid completion JSON."); }
      if (!isCompletionInput(input)) return error(400, "invalid-request", "Invalid completion input.");
      const model = completionModel(input.model);
      if (!model) return error(400, "invalid-request", "The selected model is not in Pi's Codex catalogue.");
      const previous = completions.get(ownedId);
      if (previous) return outcomeReply(completions.submit(ownedId, input, { principal: listener.principal, accounts: grant.accounts, models: grant.models }));
      const unavailable = sharedModelRefusal(availability, `${model.provider}/${model.model}`);
      if (unavailable) return reply(completionHttpStatus(unavailable.code), { error: { code: unavailable.code, message: unavailable.message } });
      if (!grant.models.includes(`${model.provider}/${model.model}`)) return error(403, "invalid-request", "This model is not shared with your Unix account.");
      const refusal = overAllowance(listener.principal);
      if (refusal) return error(403, "invalid-state", refusal);
      const outcome = mapped.owner.store.transaction<CompletionOutcome<CompletionRecord>>(() => {
        const outstanding = [...completionOwners.values()].flatMap(owner => owner.store.db.prepare("SELECT c.value FROM control c JOIN run r ON c.key='completion:'||(SELECT value FROM control WHERE key='completion-run:'||r.id) WHERE r.state IN ('queued','starting','running')").all() as { value: string }[]).filter(row => JSON.parse(row.value).access?.principal === listener.principal).length;
        if (!completions.get(ownedId) && outstanding >= listener.maxInFlight) return { ok: false as const, error: { code: "invalid-state", message: "Your completion request limit is full." } };
        return completions.submit(ownedId, input, { principal: listener.principal, accounts: grant.accounts, models: grant.models });
      });
      return outcomeReply(outcome, 202);
    }
    const family = (Object.keys(BROKER_ROUTES) as BrokerFamily[]).find(id => req.url === BROKER_ROUTES[id].path || id === "anthropic" && req.url === `${BROKER_ROUTES[id].path}?beta=true`);
    if (req.method !== "POST" || !family) { json(res, 404, "Only new model requests are available"); return; }
    if (!String(req.headers["content-type"]).startsWith("application/json")) { json(res, 415, "Expected application/json"); return; }
    const count = inflight.get(listener.principal) ?? 0;
    if (count >= listener.maxInFlight) { json(res, 503, "Your shared model request limit is full. Wait for an active request to finish."); return; }
    inflight.set(listener.principal, count + 1);
    const cancel = new AbortController();
    const signal = AbortSignal.any([shutdown.signal, cancel.signal, AbortSignal.timeout(30 * 60_000)]);
    const disconnected = () => { if (!res.writableFinished) cancel.abort(); };
    res.on("close", disconnected);
    let lease: string | undefined;
    let dispatchReceipt: DispatchReceipt | undefined;
    let dispatchAttempt = 0;
    let usageReceipt: { accountId: string; model: string; tokens: Record<UsageComponent, number> } | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > MAX_BODY) { json(res, 413, "Model request exceeds 64 MiB"); return; }
        chunks.push(Buffer.from(chunk));
      }
      const encoding = req.headers["content-encoding"];
      if (encoding && encoding !== "identity" && encoding !== "zstd") { json(res, 415, "Unsupported request encoding"); return; }
      let body: Record<string, any>;
      let requestBytes: Buffer;
      try {
        const bytes = Buffer.concat(chunks);
        requestBytes = encoding === "zstd" ? zstdDecompressSync(bytes, { maxOutputLength: MAX_BODY }) : bytes;
        body = JSON.parse(requestBytes.toString("utf8"));
      }
      catch { json(res, 400, "Invalid JSON"); return; }
      const invalid = validateBrokerBody(family, body);
      if (invalid) { json(res, 400, invalid); return; }
      const unavailable = sharedModelRefusal(availability, `${family}/${body.model}`);
      if (unavailable) { refuseModel(res, unavailable); return; }
      if (!grant.models.includes(`${family}/${body.model}`)) { json(res, 403, "This model is not shared with your Unix account"); return; }
      const ultrafast = body.service_tier === "ultrafast";
      if (ultrafast && !modelSpeedModes(family, body.model).includes("ultrafast")) { json(res, 400, "Ultrafast is only available for Codex Astra or Sol models"); return; }
      const refusal = overAllowance(listener.principal);
      if (refusal) { json(res, 403, refusal); return; }
      const shared = auth.get(family)!;
      let exclude = new Set(store.accounts().filter(account => !grant.accounts.includes(account.id)
        || !allowsAccountUse(account, "interactive")
        || store.latestMeters(account.id).some(meter => modelDrainsMeter(family, body.model, meter.meter_id)
          && Number(meter.used_percent) >= 100 && (!meter.reset_at || Number(meter.reset_at) > Date.now()))).map(account => account.id));
      if (ultrafast) exclude = await codexTierExclusions(store, shared, body.model, "ultrafast", exclude, signal, transport as typeof fetch);
      const affinity = scoped(listener.principal, body.prompt_cache_key ?? req.headers["session-id"] ?? req.headers["session_id"] ?? req.headers["x-claude-code-session-id"]);
      const retained = sticky.get(affinity);
      const account = eligibleInteractiveAccounts(store, shared, family, exclude, body.model).find(account => account.id === retained)
        ?? chooseInteractiveAccount(store, shared, family, exclude, { includeCooling: true, model: body.model });
      const granted = store.accounts().filter(candidate => candidate.provider === family && !exclude.has(candidate.id) && shared.has(candidate.id));
      if (!account && granted.length && granted.every(candidate => accountModelExcluded(store, candidate.id, body.model))) {
        json(res, 400, noEntitledAccountError(family, body.model));
        return;
      }
      if (!account) {
        json(res, 503, ultrafast
          ? "No eligible shared model account advertises Ultrafast for this model. The granted pool is unavailable, out of quota, or not entitled; no slower tier was used."
          : "No eligible shared model account. The granted pool is unavailable or out of quota.");
        return;
      }
      if (sticky.size >= 4096) sticky.delete(sticky.keys().next().value!);
      sticky.set(affinity, account.id);
      lease = `broker:${listener.principal}:${randomUUID()}`;
      store.createLease(lease, account.id, "interactive");
      usageReceipt = { accountId: account.id, model: body.model, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      timer = setInterval(() => { try { store.heartbeatLease(lease!); } catch { cancel.abort(); } }, 30_000);
      if (family === "openai-codex" && body.prompt_cache_key !== undefined) body.prompt_cache_key = affinity;
      const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream" });
      for (const key of ["anthropic-version", "anthropic-beta", "x-codex-beta-features", "user-agent", "x-app", "openai-beta", "originator", "x-stainless-retry-count", "x-stainless-runtime-version", "x-stainless-package-version", "x-stainless-runtime", "x-stainless-lang", "x-stainless-arch", "x-stainless-os", "x-stainless-timeout"]) {
        const value = req.headers[key];
        if (typeof value === "string") headers.set(key, value);
      }
      headers.set("session_id", affinity);
      headers.set("session-id", affinity);
      headers.set("x-client-request-id", affinity);
      if (family === "anthropic") headers.set("x-claude-code-session-id", affinity);
      let credential = await shared.resolve(account.id, signal);
      const authorize = () => {
        if (family === "openai-codex") {
          const resolved = imageAuth(credential, "codex");
          if (!resolved.ok) throw new Error("Codex account identity is missing");
          headers.set("chatgpt-account-id", resolved.value.headers.get("chatgpt-account-id")!);
        }
        headers.set("authorization", `Bearer ${credential.apiKey}`);
        for (const [key, value] of Object.entries(credential.headers ?? {})) if (typeof value === "string") headers.set(key, value);
      };
      authorize();
      let startedAt = 0;
      const send = async () => {
        startedAt = Date.now();
        const outgoingBody = family === "anthropic" ? Uint8Array.from(requestBytes) : JSON.stringify(body);
        if (family === "openai-codex") {
          const wire = JSON.parse(outgoingBody as string);
          dispatchReceipt = { id: `${lease}:${++dispatchAttempt}`, requestId: headers.get("x-client-request-id")!,
            principal: listener.principal, accountId: account.id, model: wire.model,
            serviceTier: typeof wire.service_tier === "string" ? wire.service_tier : "auto",
            at: startedAt, updatedAt: startedAt, outcome: "dispatched" };
          saveDispatch(dispatchReceipt);
        }
        const response = await transport(BROKER_ROUTES[family].upstream, { method: "POST", headers, body: outgoingBody, signal, redirect: "error" });
        if (dispatchReceipt) { dispatchReceipt.httpStatus = response.status; dispatchReceipt.outcome = response.ok ? "accepted" : "rejected"; saveDispatch(dispatchReceipt); }
        return response;
      };
      let response = await send();
      let repaired = false, streamRejection: string | undefined;
      if (!response.ok && credential.apiKey) {
        const repairSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
        const repair = await repairProviderCredential(shared, account.id, await providerResponseFailure(response),
          family === "openai-codex" && response.status === 404, repairSignal, credential.apiKey);
        res.setHeader("x-pi-credential-repair", encodeURIComponent(repair.detail));
        if (repair.outcome === "repaired") {
          repaired = true;
          await response.body?.cancel();
          credential = await shared.resolve(account.id, signal);
          authorize();
          response = await send();
          await quarantineProviderCredential(shared, account.id, await providerResponseFailure(response),
            family === "openai-codex" && response.status === 404, repairSignal, credential.apiKey);
        }
      }
      if (!response.ok && response.status !== 429) recordAccountModelUnsupported(store, account.id, body.model, await providerResponseFailure(response));
      if (response.status === 429) store.setCooldown(account.id, Math.max(account.cooldownUntil ?? 0, Date.now() + 60_000), { model: body.model });
      // The provider admitted this request past its quota checks; a stream that fails later is not a quota refusal.
      else if (response.ok) store.recordProviderSuccess(account.id, { model: body.model, startedAt, source: "model-broker" });
      for (const { meterId, reading } of anthropicMeterReadings(Object.fromEntries(response.headers), Date.now())) {
        store.recordMeter(account.id, meterId, reading.usedPercent, reading.resetAt, reading.at);
      }
      const outgoing: Record<string, string> = dispatchReceipt ? { "x-pi-broker-dispatch-id": dispatchReceipt.id } : {};
      for (const key of ["content-type", "retry-after", "x-request-id"]) {
        const value = response.headers.get(key);
        if (value) outgoing[key] = value;
      }
      res.writeHead(response.status, outgoing);
      const parser = createParser({ onEvent(event) {
        let value: any;
        try { value = JSON.parse(event.data); } catch { return; }
        if (dispatchReceipt && ["response.completed", "response.incomplete", "response.failed"].includes(value.type)) {
          dispatchReceipt.outcome = value.type.slice("response.".length) as "completed" | "incomplete" | "failed";
          saveDispatch(dispatchReceipt);
        }
        const failure = value.error ?? value.response?.error ?? (value.type === "error" ? value : undefined);
        if (failure) {
          const detail = `${failure.code ?? ""} ${failure.message ?? ""}`;
          recordAccountModelUnsupported(store, account.id, body.model, detail);
          if (isRejectedTokenError(detail)) streamRejection = detail;
        }
        const usage = value.type === "response.completed" ? value.response?.usage : value.type === "message_start" ? value.message?.usage : value.type === "message_delta" ? value.usage : undefined;
        if (!usage) return;
        const cached = Number(usage.input_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0);
        const input = Number(usage.input_tokens ?? 0) - (family === "openai-codex" ? cached : 0);
        for (const [component, tokens] of Object.entries({ input, output: Number(usage.output_tokens ?? 0), cacheRead: cached, cacheWrite: Number(usage.cache_creation_input_tokens ?? 0) })) {
          const key = component as UsageComponent;
          if (Number.isFinite(tokens)) usageReceipt!.tokens[key] = Math.max(usageReceipt!.tokens[key], tokens);
        }
      }, maxBufferSize: 96 * 1024 * 1024 });
      const decoder = new TextDecoder();
      if (response.body) for await (const chunk of response.body) {
        if (response.ok) parser.feed(decoder.decode(chunk, { stream: true }));
        if (!res.write(chunk)) await once(res, "drain", { signal });
      }
      if (streamRejection) {
        const repairSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
        if (repaired) await quarantineProviderCredential(shared, account.id, streamRejection, false, repairSignal, credential.apiKey);
        else await repairProviderCredential(shared, account.id, streamRejection, false, repairSignal, credential.apiKey);
      }
      res.end();
    } catch (error) {
      if (!signal.aborted) console.error(`Model broker request failed for ${listener.principal}: ${error instanceof Error ? error.name : "unknown error"}`);
      json(res, signal.aborted ? 499 : 502, signal.aborted ? "Model request cancelled" : "Model broker request failed; inspect the broker service and account authentication");
    } finally {
      if (dispatchReceipt && ["dispatched", "accepted"].includes(dispatchReceipt.outcome)) {
        dispatchReceipt.outcome = signal.aborted ? "cancelled" : "indeterminate";
        saveDispatch(dispatchReceipt);
      }
      clearInterval(timer);
      if (lease && usageReceipt) for (const [component, tokens] of Object.entries(usageReceipt.tokens)) {
        if (tokens > 0) store.recordUsage({ accountId: usageReceipt.accountId, hour: Math.floor(Date.now() / 3_600_000) * 3_600_000, source: "interactive", runId: lease, model: usageReceipt.model, component: component as UsageComponent, tokens });
      }
      if (lease) store.endLease(lease);
      res.off("close", disconnected);
      inflight.set(listener.principal, (inflight.get(listener.principal) ?? 1) - 1);
    }
  };
  publish();
  const trackedRequest = (principal: string, req: IncomingMessage, res: ServerResponse, listenerAuthority?: BrokerRequestAuthority): Promise<void> => {
    if (draining) { json(res, 503, "Broker custody is draining; reconcile accepted IDs with its successor"); return Promise.resolve(); }
    const listener = config.listeners.find(candidate => candidate.principal === principal);
    if (!listener) { json(res, 403, "Principal has no model grant"); return Promise.resolve(); }
    const work = (async () => {
      for (const authority of [listenerAuthority, embedded?.authorizeRequest]) {
        if (!authority) continue;
        const authorized = await authority(principal, req);
        if (!authorized.ok) { json(res, authorized.status, authorized.message); return; }
      }
      if (draining) { json(res, 503, "Broker custody is draining"); return; }
      await request(listener, req, res);
    })().catch(error => {
      console.error("Model broker request failed:", error instanceof Error ? error.message : String(error));
      json(res, 500, "Broker request failed");
    });
    active.add(work);
    void work.finally(() => active.delete(work));
    return work;
  };
  return {
    request: trackedRequest,
    /** Trusted adoption binds an exact old stored identity; it never submits provider work. */
    adoptCompletion(principal: string, requestId: string, storedRequestId: string, ownerId = "current"): CompletionOutcome<CompletionRecord> {
      if (!isCompletionRequestId(requestId) || !isCompletionRequestId(storedRequestId)) return { ok: false, error: { code: "invalid-request", message: "Invalid adoption identity" } };
      const grant = grants.get(principal);
      if (!grant) return { ok: false, error: { code: "invalid-request", message: "Principal has no broker grant" } };
      const owner = completionOwners.get(ownerId);
      if (!owner) return { ok: false, error: { code: "invalid-state", message: "Retained ledger owner is not registered" } };
      const ownedId = `broker-${scoped(principal, requestId)}`, aliasKey = `completion-alias:${ownedId}`;
      const reverseKey = `completion-public-owner:${JSON.stringify([ownerId, storedRequestId])}`;
      const reserved = store.transaction<CompletionOutcome<void>>(() => {
        const encoded = store.control(aliasKey), alias = encoded ? JSON.parse(encoded) as CompletionAlias : undefined;
        if (alias && (alias.requestId !== storedRequestId || alias.ownerId !== ownerId) || !alias && completionOwners.get("current")!.service.get(ownedId) && (ownerId !== "current" || ownedId !== storedRequestId)) return { ok: false, error: { code: "request-conflict", message: "Public ID already has different custody" } };
        const reverse = store.control(reverseKey);
        if (reverse && reverse !== ownedId) return { ok: false, error: { code: "request-conflict", message: "Stored completion already has another public identity" } };
        store.setControl(aliasKey, JSON.stringify({ state: "adopting", ownerId, requestId: storedRequestId } satisfies CompletionAlias));
        store.setControl(reverseKey, ownedId);
        return { ok: true, value: undefined };
      });
      if (!reserved.ok) return reserved;
      const adopted = owner.service.adoptAccess(storedRequestId, { principal, accounts: grant.accounts, models: grant.models });
      if (!adopted.ok) return adopted;
      store.setControl(aliasKey, JSON.stringify({ state: "ready", ownerId, requestId: storedRequestId } satisfies CompletionAlias));
      return { ok: true, value: { ...adopted.value, requestId } };
    },
    /** Apply a reloaded grant file. Listener principals and ports are process topology; only what
     * each principal may spend changes here. */
    applyGrants(listeners: readonly BrokerListener[]): void {
      for (const listener of listeners) {
        if (!grants.has(listener.principal)) continue;
        grants.set(listener.principal, { accounts: listener.accounts, models: listener.models, weeklyUsd: listener.weeklyUsd });
        const configured = config.listeners.find(value => value.principal === listener.principal)!;
        configured.maxInFlight = listener.maxInFlight;
      }
      publish();
    },
    listen(principals?: readonly string[], listenerAuthority?: BrokerRequestAuthority): Promise<number[]> {
      if (draining) return Promise.reject(new Error("Broker custody is draining"));
      if (listening) return listening;
      if (principals && (new Set(principals).size !== principals.length || principals.some(principal => !config.listeners.some(listener => listener.principal === principal)))) return Promise.reject(new Error("Unknown or duplicate retained listener principal"));
      listening = (async () => { try {
        publish();
        for (const listener of config.listeners.filter(listener => principals === undefined || principals.includes(listener.principal))) {
          const server = createServer((req, res) => { void trackedRequest(listener.principal, req, res, listenerAuthority); });
          attachMeetRecognitionBroker(server, shutdown.signal, () => {
            const count = inflight.get(listener.principal) ?? 0;
            if (count >= listener.maxInFlight) return false;
            inflight.set(listener.principal, count + 1);
            return true;
          }, () => inflight.set(listener.principal, Math.max(0, (inflight.get(listener.principal) ?? 1) - 1)), async req => {
            if (draining) return false;
            for (const authority of [listenerAuthority, embedded?.authorizeRequest]) {
              if (authority && !(await authority(listener.principal, req)).ok) return false;
            }
            return !draining;
          });
          servers.push(server);
          await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(listener.port, "127.0.0.1", resolve); });
        }
        return servers.map(server => (server.address() as { port: number }).port);
      } catch (error) { await this.close(); throw error; } })();
      return listening;
    },
    close(): Promise<void> {
      if (!closed) closed = (async () => {
        draining = true;
        const listeners = servers.map(server => new Promise<void>(resolve => server.close(() => resolve())));
        await Promise.all([...active]);
        for (const server of servers) server.closeIdleConnections();
        await Promise.all(listeners);
        shutdown.abort();
        if (!embedded) store.close();
      })();
      return closed;
    },
  };
}

export function loadBrokerConfig(path: string): ModelBrokerConfig {
  const info = statSync(path);
  if (info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error("Model broker grants must be in a root-owned file without group/other write access");
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!validateBrokerConfig(config)) throw new Error("Invalid model broker configuration");
  return config;
}

export async function runModelBroker(path: string): Promise<void> {
  const config = loadBrokerConfig(path);
  const broker = createModelBroker(config, new ModelAvailabilityStore(modelAvailabilityPath()));
  await broker.listen();
  const topology = (listeners: readonly BrokerListener[]) => listeners.map(listener => `${listener.principal}:${listener.port}`).sort().join(",");
  // An edited grant file reaches queued completions and live routing without cancelling active
  // requests. Adding or moving a listener is process topology and still needs a restart.
  watchFile(path, { interval: 2_000 }, () => {
    let reloaded: ModelBrokerConfig;
    try { reloaded = loadBrokerConfig(path); }
    catch (error) { console.error(`Model broker kept its current grants: ${error instanceof Error ? error.message : "unreadable grant file"}`); return; }
    if (reloaded.grantOwner !== config.grantOwner) {
      console.error(`Model broker grant owner changed in ${path}; restart with the intended owner`);
      return;
    }
    if (topology(reloaded.listeners) !== topology(config.listeners)) console.error(`Model broker listeners changed in ${path}; restart the service to serve them`);
    broker.applyGrants(reloaded.listeners);
  });
  await new Promise<void>(resolve => {
    const stop = () => { process.off("SIGTERM", stop); process.off("SIGINT", stop); resolve(); };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  unwatchFile(path);
  await broker.close();
}
