import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadCoreConfig, type CoreResult } from "./config.js";
import type { CoreConfig } from "./contracts.js";
import { CoreService } from "./service.js";
import { createCoreCustodyFactory } from "./custody.js";
import { CoreImages } from "./images.js";
import { createCoreMemory, type CoreMemoryAdapter } from "./memory.js";
import { authorize } from "../permissions.js";
import { CoreDuties } from "./duties-runtime.js";
import { createCoreProvider, type CoreProvider } from "./provider.js";
import { createCoreRootIntegration, type CoreRootPlugin } from "./root.js";
import { webRequest, writeResponse } from "./http.js";
import { startCallbackTransports, type CallbackTransports } from "./callback-transports.js";

export type RunningCore = { service: CoreService; close(): Promise<CoreResult<void>> };
export async function serveCore(config: CoreConfig): Promise<CoreResult<RunningCore>> {
  const shutdown = new AbortController();
  const core = new CoreService(config, createCoreCustodyFactory(config.root.kind === "configured" ? [config.root.consultationScopeId, ...config.root.consultationOwners.map(owner => owner.scopeId)] : null));
  let provider: CoreProvider | undefined, root: CoreRootPlugin | null = null, images: CoreImages | undefined, memory: CoreMemoryAdapter | undefined;
  const duties = new CoreDuties(config.duties, { scopes: config.scopes, principals: config.principals, policy: config.policy, owner: id => core.owner(id), enabled: () => !shutdown.signal.aborted });
  let callbacks: CallbackTransports | undefined;
  let server: Server | undefined, clock: ReturnType<typeof setInterval> | undefined;
  let reconciliation: Promise<void> | undefined, closing: Promise<CoreResult<void>> | undefined;
  let healthy = true;
  const close = (): Promise<CoreResult<void>> => {
    if (closing) return closing;
    closing = (async (): Promise<CoreResult<void>> => {
      shutdown.abort();
      if (clock) clearInterval(clock);
      try {
        await callbacks?.close();
        await root?.drain();
        await reconciliation;
        await root?.close();
        await duties.close();
        await images?.close();
        const detached = await core.close();
        if (!detached.ok) { closing = undefined; return detached; }
        await memory?.close();
        await provider?.close();
        if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
        return { ok: true, value: undefined };
      } catch (cause) {
        closing = undefined;
        return { ok: false, error: { code: "unavailable", message: `Core drain incomplete: ${cause instanceof Error ? cause.message : String(cause)}` } };
      }
    })();
    return closing;
  };
  try {
    const adopted = await core.start();
    if (!adopted.ok) return adopted;
    if (config.broker.kind === "configured") {
      const built = createCoreProvider(config.broker, config.policy);
      if (!built.ok) { await close(); return built; }
      provider = built.value;
    }
    const memoryBuilt = createCoreMemory({ config: config.memory, principals: config.principals, policy: config.policy, scopes: config.scopes, owner: id => core.owner(id), enabled: () => true, releaseCommit: config.releaseCommit });
    if (!memoryBuilt.ok) { await close(); return memoryBuilt; }
    memory = memoryBuilt.value;
    if (config.images.kind === "configured") {
      if (!provider) { await close(); return { ok: false, error: { code: "invalid-config", message: "Image generation requires the configured shared provider owner" } }; }
      images = new CoreImages(config.images, { accounts: provider.imageAccounts,
        scope: id => {
          const owner = core.owner(id), scope = config.scopes.find(scope => scope.id === id);
          if (!owner.ok) return owner;
          if (!scope) return { ok: false, error: { code: "invalid-config", message: "Unknown image scope" } };
          return { ok: true, value: { runtime: owner.value.runtime, uid: scope.custody.uid, threads: owner.value.threads, allowsThread: threadId => !!owner.value.threads.get(threadId) } };
        },
        authorize: (request, id, resource, actions) => core.authorizeScope(request, id, resource, actions),
        authorizeNative: (id, resource, actions) => {
          const scope = config.scopes.find(scope => scope.id === id), principal = config.principals.find(principal => principal.id === scope?.principalId);
          if (!scope || !principal) return { ok: false, error: { code: "invalid-config", message: "Unknown native image principal" } };
          for (const action of actions) {
            const grant = authorize(config.policy, { principal, resource, action, now: Date.now() });
            if (!grant.ok) return { ok: false, error: { code: "unavailable", message: grant.error.message } };
          }
          return { ok: true, value: undefined };
        },
      });
      const started = await images.start();
      if (!started.ok) { await close(); return started; }
    }
    const adoptedDuties = await duties.start();
    if (!adoptedDuties.ok) { await close(); return adoptedDuties; }
    const integrated = await createCoreRootIntegration(config.root, config.scopes, id => core.owner(id), { releaseCommit: config.releaseCommit, shutdownSignal: shutdown.signal,
      authorizeAdmin: (request, id, actions) => {
        const scope = config.scopes.find(scope => scope.id === id);
        return scope ? core.authorizeScope(request, id, scope.resource, actions) : { ok: false, error: { code: "invalid-config", message: "Unknown consultation scope" } };
      },
    });
    if (!integrated.ok) { await close(); return integrated; }
    root = integrated.value;
    const retained = await startCallbackTransports(config.callbacks, { root, memory: config.memory.kind === "configured" ? memory ?? null : null });
    if (!retained.ok) { await close(); return retained; }
    callbacks = retained.value;
    server = createServer((req, res) => {
      const abort = new AbortController();
      res.once("close", () => abort.abort());
      void (async () => {
        const path = new URL(req.url ?? "/", core.url).pathname;
        const brokerRoute = path.startsWith("/v1/model-broker/");
        const memoryRoute = path === "/v1/memory" || path === "/v1/sessions" || path.startsWith("/v1/root/");
        if (memoryRoute && memory) { memory.request(req, res); return; }
        const request = webRequest(req, core.url, abort.signal, brokerRoute ? "unread" : "stream");
        let response: Response | undefined;
        if (path === "/health" || path === "/v1/health") {
          response = Response.json({ ok: healthy && !shutdown.signal.aborted, service: "pi-stack-core", releaseCommit: config.releaseCommit, scopeCount: config.scopes.length }, { status: healthy && !shutdown.signal.aborted ? 200 : 503 });
        } else if (brokerRoute || path.startsWith("/v1/providers")) {
          const principal = core.authenticate(request);
          if (!principal.ok) response = Response.json(principal, { status: 401 });
          else if (!provider) response = Response.json({ error: { code: "unavailable", message: "Model provider is not configured" } }, { status: 503 });
          else {
            const result = await provider.request(principal.value, request, req, res);
            if (result) response = result;
            else if (brokerRoute) return;
          }
        } else if (root && (path === "/v1/ask" || path.startsWith("/v1/ask/") || path.startsWith("/v1/admin/"))) {
          response = await root.fetch(request);
        } else response = await images?.handle(request) ?? await core.request(request);
        await writeResponse(response ?? Response.json({ error: { code: "not-found", message: "Unknown core operation" } }, { status: 404 }), res);
      })().catch(cause => {
        if (abort.signal.aborted) return;
        console.error(`Core request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        if (res.headersSent) res.destroy();
        else { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "unavailable", message: "Core request failed; inspect existing request identity before retry" } })); }
      });
    });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(config.port, config.host, () => { server!.off("error", reject); resolve(); }); });
    const activated = await core.activate();
    if (!activated.ok) { await close(); return activated; }
    const reconcile = () => {
      provider?.tick();
      if (reconciliation || shutdown.signal.aborted) return;
      reconciliation = (async () => {
        const results = await Promise.allSettled([provider?.reconcile(), root?.reconcile(), duties.tick()]);
        healthy = results.every(result => result.status === "fulfilled" && (!result.value || (!("errors" in result.value) || result.value.errors === 0) && (!("ok" in result.value) || result.value.ok)));
        for (const result of results) if (result.status === "rejected") console.error(`Core reconciliation failed: ${String(result.reason)}`);
      })().finally(() => { reconciliation = undefined; });
    };
    clock = setInterval(reconcile, 1_000); reconcile();
    return { ok: true, value: { service: core, close } };
  } catch (cause) {
    const drained = await close();
    return { ok: false, error: { code: "unavailable", message: `Core startup failed: ${cause instanceof Error ? cause.message : String(cause)}${drained.ok ? "" : `; ${drained.error.message}`}` } };
  }
}

async function main(): Promise<void> {
  const [command, path, ...extra] = process.argv.slice(2);
  if (!path || extra.length || !["--check-config", "serve"].includes(command!)) { console.error("Usage: pi-stack-core --check-config|serve /absolute/core.json"); process.exitCode = 2; return; }
  const config = loadCoreConfig(path);
  if (!config.ok) { console.error(JSON.stringify(config)); process.exitCode = 1; return; }
  if (command === "--check-config") { console.log(JSON.stringify({ ok: true, scopes: config.value.scopes.map(scope => scope.id), releaseCommit: config.value.releaseCommit })); return; }
  const running = await serveCore(config.value);
  if (!running.ok) { console.error(JSON.stringify(running)); process.exitCode = 1; return; }
  const stop = () => { void running.value.close().then(result => { if (!result.ok) { console.error(JSON.stringify(result)); process.exitCode = 1; } }); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(cause => { console.error(cause); process.exitCode = 1; });
