import { createHash, randomUUID } from "node:crypto";
import { allowanceRefusal, BROKER_USAGE_PATH, brokerUsage, WeeklyAllowances } from "./broker-usage.js";
import { weekResetsAt } from "./person-usage.js";
import { zstdDecompressSync } from "node:zlib";
import { once } from "node:events";
import { readFileSync, statSync, unwatchFile, watchFile } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createParser } from "eventsource-parser";
import { Store } from "./store.js";
import { CompletionService } from "./completion.js";
import { isCompletionInput, isCompletionRequestId } from "./completion-contract.js";
import { catalogModel, modelDrainsMeter } from "./catalog.js";
import type { UsageComponent } from "./domain.js";
import { imageAuth } from "./image-service.js";
import { chooseInteractiveAccount, eligibleInteractiveAccounts } from "./auth/account-selection.js";
import { providerOAuth } from "./auth/shared-oauth.js";
import { repairProviderCredential } from "./auth/provider-rejection.js";
import { BROKER_ROUTES, validateBrokerBody, type BrokerFamily } from "./model-broker-contract.js";
import { anthropicMeterReadings } from "./extension/usage-logger.js";
import { forwardVoiceRequest } from "./voice-broker.js";

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
}
export function validateBrokerConfig(value: unknown): value is ModelBrokerConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as ModelBrokerConfig;
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.length > 0 && items.every(item => typeof item === "string" && item.length > 0);
  return typeof config.ledgerPath === "string" && config.ledgerPath.startsWith("/")
    && typeof config.authPath === "string" && config.authPath.startsWith("/")
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

export type BrokerTransport = (url: string, init: RequestInit) => Promise<Response>;
export function createModelBroker(config: ModelBrokerConfig, transport: BrokerTransport = fetch) {
  const store = Store.open(config.ledgerPath);
  // Grants are desired state the broker owns for every consumer of the ledger, including daemon
  // admission of completions this broker queued earlier. Reloading the grant file republishes them.
  const grants = new Map(config.listeners.map(listener => [listener.principal, { accounts: listener.accounts, models: listener.models, weeklyUsd: listener.weeklyUsd }]));
  const allowances = new WeeklyAllowances(store);
  const overAllowance = (principal: string) => {
    const weeklyUsd = grants.get(principal)!.weeklyUsd;
    if (weeklyUsd === undefined) return null;
    const used = allowances.spent(principal);
    return used >= weeklyUsd ? allowanceRefusal(weeklyUsd) : null;
  };
  const publish = () => store.publishBrokerGrants([...grants].map(([principal, grant]) => ({ principal, ...grant })));
  const completions = new CompletionService(store, process.cwd());
  const providers = new Map(builtinProviders().filter(provider => provider.id in BROKER_ROUTES).map(provider => [provider.id, provider]));
  const auth = new Map([...providers].map(([id, provider]) => [id, providerOAuth(provider, config.authPath)]));
  const active = new Set<Promise<void>>();
  const inflight = new Map<string, number>();
  const sticky = new Map<string, string>();
  const shutdown = new AbortController();
  const servers: Server[] = [];

  const request = async (listener: BrokerListener, req: IncomingMessage, res: ServerResponse) => {
    const grant = grants.get(listener.principal)!;
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
      try { body = JSON.stringify(brokerUsage(store, listener.principal, grant.accounts, Date.now(), grant.weeklyUsd === undefined ? null : { weeklyUsd: grant.weeklyUsd, usedUsd: allowances.spent(listener.principal, 0), resetsAt: new Date(weekResetsAt()).toISOString() })); }
      catch (error) { console.error(`Model broker usage failed for ${listener.principal}: ${error instanceof Error ? error.message : "unknown error"}`); json(res, 500, "Usage is unavailable"); return; }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    const completionRoute = /^\/v1\/completions\/([^/?]+)$/.exec(req.url ?? "");
    if (completionRoute && (req.method === "GET" || req.method === "PUT")) {
      const reply = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      const error = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
      let requestId: string;
      try { requestId = decodeURIComponent(completionRoute[1]!); }
      catch { return error(400, "invalid-request", "Invalid completion request ID encoding."); }
      if (!isCompletionRequestId(requestId)) return error(400, "invalid-request", "Invalid completion request ID.");
      const ownedId = `broker-${scoped(listener.principal, requestId)}`;
      if (req.method === "GET") {
        const record = completions.get(ownedId);
        return record ? reply(200, { ...record, requestId }) : error(404, "not-found", "Completion not found.");
      }
      let input: unknown;
      try {
        let length = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) { length += chunk.length; if (length > MAX_BODY) return error(413, "invalid-request", "Completion request exceeds 64 MiB."); chunks.push(Buffer.from(chunk)); }
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { return error(400, "invalid-request", "Invalid completion JSON."); }
      if (!isCompletionInput(input)) return error(400, "invalid-request", "Invalid completion input.");
      const model = catalogModel(input.model)!;
      if (!grant.models.includes(`${model.provider}/${model.model}`)) return error(403, "invalid-request", "This model is not shared with your Unix account.");
      const refusal = completions.get(ownedId) ? null : overAllowance(listener.principal);
      if (refusal) return error(403, "invalid-state", refusal);
      const outcome = store.transaction(() => {
        const outstanding = (store.db.prepare("SELECT c.value FROM control c JOIN run r ON c.key='completion:'||(SELECT value FROM control WHERE key='completion-run:'||r.id) WHERE r.state IN ('queued','starting','running')").all() as { value: string }[]).filter(row => JSON.parse(row.value).access?.principal === listener.principal).length;
        if (!completions.get(ownedId) && outstanding >= listener.maxInFlight) return { ok: false as const, error: { code: "invalid-state", message: "Your completion request limit is full." } };
        return completions.submit(ownedId, input, { principal: listener.principal, accounts: grant.accounts, models: grant.models });
      });
      return outcome.ok ? reply(202, { ...outcome.value, requestId }) : error(400, outcome.error.code, outcome.error.message);
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
      if (!grant.models.includes(`${family}/${body.model}`)) { json(res, 403, "This model is not shared with your Unix account"); return; }
      const refusal = overAllowance(listener.principal);
      if (refusal) { json(res, 403, refusal); return; }
      const shared = auth.get(family)!;
      const exclude = new Set(store.accounts().filter(account => !grant.accounts.includes(account.id)
        || store.latestMeters(account.id).some(meter => modelDrainsMeter(family, body.model, meter.meter_id)
          && Number(meter.used_percent) >= 100 && (!meter.reset_at || Number(meter.reset_at) > Date.now()))).map(account => account.id));
      const affinity = scoped(listener.principal, body.prompt_cache_key ?? req.headers["session-id"] ?? req.headers["session_id"] ?? req.headers["x-claude-code-session-id"]);
      const retained = sticky.get(affinity);
      const account = eligibleInteractiveAccounts(store, shared, family, exclude).find(account => account.id === retained)
        ?? chooseInteractiveAccount(store, shared, family, exclude, { includeCooling: true, model: body.model });
      if (!account) { json(res, 503, "No eligible shared model account. The granted pool is unavailable or out of quota."); return; }
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
      const send = () => transport(BROKER_ROUTES[family].upstream, { method: "POST", headers, body: family === "anthropic" ? Uint8Array.from(requestBytes) : JSON.stringify(body), signal, redirect: "error" });
      let response = await send();
      if ((response.status === 401 || family === "openai-codex" && response.status === 404) && credential.apiKey) {
        const repair = await repairProviderCredential(shared, account.id, `HTTP ${response.status}`,
          family === "openai-codex" && response.status === 404, signal, credential.apiKey);
        res.setHeader("x-pi-credential-repair", encodeURIComponent(repair.detail));
        if (repair.outcome === "repaired") {
          await response.body?.cancel();
          credential = await shared.resolve(account.id, signal);
          authorize();
          response = await send();
        }
      }
      if (response.status === 429) store.setCooldown(account.id, Math.max(account.cooldownUntil ?? 0, Date.now() + 60_000));
      for (const { meterId, reading } of anthropicMeterReadings(Object.fromEntries(response.headers), Date.now())) {
        store.recordMeter(account.id, meterId, reading.usedPercent, reading.resetAt, reading.at);
      }
      const outgoing: Record<string, string> = {};
      for (const key of ["content-type", "retry-after", "x-request-id"]) {
        const value = response.headers.get(key);
        if (value) outgoing[key] = value;
      }
      res.writeHead(response.status, outgoing);
      const parser = createParser({ onEvent(event) {
        let value: any;
        try { value = JSON.parse(event.data); } catch { return; }
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
      res.end();
    } catch (error) {
      if (!signal.aborted) console.error(`Model broker request failed for ${listener.principal}: ${error instanceof Error ? error.name : "unknown error"}`);
      json(res, signal.aborted ? 499 : 502, signal.aborted ? "Model request cancelled" : "Model broker request failed; inspect the broker service and account authentication");
    } finally {
      clearInterval(timer);
      if (lease && usageReceipt) for (const [component, tokens] of Object.entries(usageReceipt.tokens)) {
        if (tokens > 0) store.recordUsage({ accountId: usageReceipt.accountId, hour: Math.floor(Date.now() / 3_600_000) * 3_600_000, source: "interactive", runId: lease, model: usageReceipt.model, component: component as UsageComponent, tokens });
      }
      if (lease) store.endLease(lease);
      res.off("close", disconnected);
      inflight.set(listener.principal, (inflight.get(listener.principal) ?? 1) - 1);
    }
  };
  return {
    /** Apply a reloaded grant file. Listener principals and ports are process topology; only what
     * each principal may spend changes here. */
    applyGrants(listeners: readonly BrokerListener[]): void {
      for (const listener of listeners) {
        if (!grants.has(listener.principal)) continue;
        grants.set(listener.principal, { accounts: listener.accounts, models: listener.models, weeklyUsd: listener.weeklyUsd });
      }
      publish();
    },
    async listen() {
      try {
        publish();
        for (const listener of config.listeners) {
          const server = createServer((req, res) => {
            const work = request(listener, req, res);
            active.add(work);
            void work.finally(() => active.delete(work));
          });
          servers.push(server);
          await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(listener.port, "127.0.0.1", resolve); });
        }
        return servers.map(server => (server.address() as { port: number }).port);
      } catch (error) { await this.close(); throw error; }
    },
    async close() {
      shutdown.abort();
      for (const server of servers) { server.closeAllConnections(); server.close(); }
      await Promise.allSettled(active);
      store.close();
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
  const broker = createModelBroker(config);
  await broker.listen();
  const topology = (listeners: readonly BrokerListener[]) => listeners.map(listener => `${listener.principal}:${listener.port}`).sort().join(",");
  // An edited grant file reaches queued completions and live routing without cancelling active
  // requests. Adding or moving a listener is process topology and still needs a restart.
  watchFile(path, { interval: 2_000 }, () => {
    let reloaded: ModelBrokerConfig;
    try { reloaded = loadBrokerConfig(path); }
    catch (error) { console.error(`Model broker kept its current grants: ${error instanceof Error ? error.message : "unreadable grant file"}`); return; }
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
