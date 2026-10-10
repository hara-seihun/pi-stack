import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { CoreResult } from "./config.js";
import { webRequest, writeResponse } from "./http.js";

export type CallbackListener = {
  id: string;
  subsystem: "root" | "memory";
  host: "127.0.0.1" | "::1";
  port: number;
  previousOwner: string;
  detachmentReceiptPath: string;
};
export type CoreCallbackConfig = { kind: "none" } | { kind: "retained"; listeners: CallbackListener[] };
export type CallbackPlugins = {
  root: { fetch(request: Request): Promise<Response> } | null;
  memory: { request(request: IncomingMessage, response: ServerResponse): void } | null;
};
export type CallbackTransports = { close(): Promise<void> };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function parseCoreCallbackConfig(value: unknown, canonical: { host: string; port: number }): CoreResult<CoreCallbackConfig> {
  const invalid = (): CoreResult<never> => ({ ok: false, error: { code: "invalid-config", message: "Retained callbacks require unique loopback ports, exact subsystem and old-owner detachment receipts" } });
  if (!object(value)) return invalid();
  if (value.kind === "none" && Object.keys(value).length === 1) return { ok: true, value: { kind: "none" } };
  if (value.kind !== "retained" || !Array.isArray(value.listeners) || !value.listeners.length) return invalid();
  const ids = new Set<string>(), ports = new Set<number>();
  for (const item of value.listeners) {
    if (!object(item) || typeof item.id !== "string" || !/^[a-zA-Z0-9_.:-]+$/.test(item.id) || ids.has(item.id)
      || !["root", "memory"].includes(String(item.subsystem)) || !["127.0.0.1", "::1"].includes(String(item.host))
      || !Number.isSafeInteger(item.port) || Number(item.port) < 1 || Number(item.port) > 65535 || ports.has(Number(item.port)) || item.port === canonical.port
      || typeof item.previousOwner !== "string" || !item.previousOwner.trim()
      || typeof item.detachmentReceiptPath !== "string" || !isAbsolute(item.detachmentReceiptPath) || resolve(item.detachmentReceiptPath) !== item.detachmentReceiptPath || /[\0\r\n]/.test(item.detachmentReceiptPath)) return invalid();
    ids.add(item.id); ports.add(Number(item.port));
  }
  return { ok: true, value: value as unknown as CoreCallbackConfig };
}
export function validateCallbackReceipt(listener: CallbackListener, receipt: unknown): CoreResult<void> {
  if (!object(receipt) || receipt.version !== 1 || receipt.state !== "detached" || receipt.listenerId !== listener.id || receipt.subsystem !== listener.subsystem
    || receipt.host !== listener.host || receipt.port !== listener.port || !object(receipt.previousOwner) || receipt.previousOwner.identity !== listener.previousOwner
    || typeof receipt.previousOwner.detachedAt !== "string" || !Number.isFinite(Date.parse(receipt.previousOwner.detachedAt)))
    return { ok: false, error: { code: "ownership-conflict", message: `Receipt does not bind detached callback ${listener.id}` } };
  return { ok: true, value: undefined };
}
export function verifyCallbackDetachment(listener: CallbackListener): CoreResult<void> {
  try {
    const file = lstatSync(listener.detachmentReceiptPath);
    if (!file.isFile() || file.uid !== 0 || file.mode & 0o022) throw new Error("Callback receipt must be a protected root-owned regular file");
    const receipt = JSON.parse(readFileSync(listener.detachmentReceiptPath, "utf8"));
    return validateCallbackReceipt(listener, receipt);
  } catch (cause) { return { ok: false, error: { code: "ownership-conflict", message: `Cannot adopt callback ${listener.id}: ${String(cause)}` } }; }
}
const memoryRoutes = new Set(["/v1/health", "/v1/memory", "/v1/sessions", "/v1/root/admit", "/v1/root/finalize-reply", "/v1/root/resume-consent", "/v1/root/log-consent", "/v1/root/authorize-request", "/v1/root/authenticate-caller", "/v1/root/resume-request", "/v1/root/log-notification", "/v1/root/log-request-status"]);
const rootRoute = (path: string) => path === "/v1/health" || path === "/v1/ask" || path.startsWith("/v1/ask/") || path.startsWith("/v1/admin/");
export function callbackHandler(listener: CallbackListener, plugins: CallbackPlugins): (req: IncomingMessage, res: ServerResponse) => void {
  const base = `http://${listener.host === "::1" ? "[::1]" : listener.host}:${listener.port}`;
  return (req, res) => {
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    void (async () => {
      const path = new URL(req.url ?? "/", base).pathname;
      if (listener.subsystem === "memory" && memoryRoutes.has(path) && plugins.memory) { plugins.memory.request(req, res); return; }
      if (listener.subsystem === "root" && rootRoute(path) && plugins.root) {
        await writeResponse(await plugins.root.fetch(webRequest(req, base, abort.signal, "stream")), res); return;
      }
      await writeResponse(Response.json({ error: "not-found" }, { status: 404 }), res);
    })().catch(cause => {
      if (abort.signal.aborted) return;
      console.error(`Retained callback ${listener.id} failed: ${String(cause)}`);
      if (res.headersSent) res.destroy();
      else { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unavailable", message: "Inspect original request identity before retry" })); }
    });
  };
}
const activeResponses = new WeakMap<Server, Set<ServerResponse>>();
export function createCallbackServer(listener: CallbackListener, plugins: CallbackPlugins): Server {
  const responses = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    responses.add(res);
    const finished = () => { responses.delete(res); if (!server.listening) server.closeIdleConnections(); };
    res.once("finish", finished); res.once("close", finished);
    callbackHandler(listener, plugins)(req, res);
  });
  activeResponses.set(server, responses);
  return server;
}
export function drainCallbackServers(servers: readonly Server[]): Promise<void> {
  return Promise.all(servers.map(server => server.listening ? new Promise<void>((done, reject) => {
    for (const response of activeResponses.get(server) ?? []) if (!response.headersSent) response.setHeader("connection", "close");
    server.close(error => error ? reject(error) : done()); server.closeIdleConnections();
  }) : Promise.resolve())).then(() => {});
}
export async function startCallbackTransports(config: CoreCallbackConfig, plugins: CallbackPlugins): Promise<CoreResult<CallbackTransports>> {
  const servers: Server[] = [];
  let closing: Promise<void> | undefined;
  const close = () => closing ??= drainCallbackServers(servers);
  if (config.kind === "none") return { ok: true, value: { close } };
  for (const listener of config.listeners) {
    if (listener.subsystem === "root" ? !plugins.root : !plugins.memory)
      return { ok: false, error: { code: "invalid-config", message: `Callback ${listener.id} requires its canonical configured plugin` } };
    const detached = verifyCallbackDetachment(listener);
    if (!detached.ok) return detached;
  }
  try {
    for (const listener of config.listeners) {
      const server = createCallbackServer(listener, plugins); servers.push(server);
      await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen(listener.port, listener.host, () => { server.off("error", reject); done(); });
      });
    }
    return { ok: true, value: { close } };
  } catch (cause) {
    await close();
    return { ok: false, error: { code: "unavailable", message: `Retained callback bind failed: ${String(cause)}` } };
  }
}
