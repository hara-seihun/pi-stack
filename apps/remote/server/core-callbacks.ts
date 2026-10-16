import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { acquireGatewaySocketOwner, createGatewayServer, gatewayAuthority, remoteCallbackSource, recoverGatewaySocket, webRequest, writeResponse, type GatewayBinding, type GatewayRoute } from "pi-orchestrator/core-gateway";
import type { Result } from "pi-orchestrator/api";
import type { CoreClientConfig } from "./core-client";

const operations = ["managerNotificationPolicy", "managerWorkSummary", "send", "questionOrigin", "managerQuestionCustody", "managerReplies"] as const;
export function coreCallbackRoutes(): GatewayRoute[] {
  return ["/v1/core/prepare-message", ...operations.map(operation => `/v1/core/manager-relay/${operation}`)].map(path => ({ method: "POST", kind: "exact", path }));
}
export type CoreCallbacks = {
  prepare(input: unknown, sourceScopeId: string): Promise<Response>;
  relay(operation: typeof operations[number], input: unknown, signal: AbortSignal): Promise<Response>;
};
const error = (message: string, status: number) => Response.json({ ok: false, error: { code: status === 403 ? "forbidden" : "unavailable", message } }, { status });
export async function handleCoreCallback(request: Request, config: Pick<CoreClientConfig, "scopeId" | "principalId" | "coreUid">, callbacks: CoreCallbacks): Promise<Response> {
  const authority = gatewayAuthority(request);
  if (!authority || authority.purpose !== "remote-callback" || authority.peerUid !== config.coreUid || authority.principalId !== config.principalId || authority.scopeIds.length !== 1 || authority.scopeIds[0] !== config.scopeId) return error("Verified scoped core kernel peer required", 403);
  const source = remoteCallbackSource(request, config);
  if (!source.ok) return error(source.error.message, 403);
  const path = new URL(request.url).pathname;
  if (!coreCallbackRoutes().some(route => route.method === request.method && route.path === path)) return error("Unknown core callback", 403);
  let input: unknown;
  try { input = await request.json(); } catch { return error("Expected callback JSON", 400); }
  if (path === "/v1/core/prepare-message") return callbacks.prepare(input, source.value);
  return callbacks.relay(path.slice("/v1/core/manager-relay/".length) as typeof operations[number], input, request.signal);
}

export async function startCoreCallbacks(config: CoreClientConfig, ownerUid: number, callbacks: CoreCallbacks): Promise<Result<{ close(): Promise<void> }>> {
  const path = config.callbackSocket;
  let unlock: (() => void) | null = null;
  let transport: ReturnType<typeof createGatewayServer> | null = null;
  let identity: { dev: bigint; ino: bigint } | null = null;
  let closing: Promise<void> | null = null;
  const close = () => closing ??= (async () => {
    try {
      await transport?.close();
      if (identity) {
        try {
          const current = lstatSync(path, { bigint: true });
          if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(path);
        } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
      }
    } finally { unlock?.(); unlock = null; }
  })();
  try {
    if (!Number.isSafeInteger(ownerUid) || ownerUid < 0 || path !== `/run/pi-stack/gateways/remote-${config.scopeId}/callback.sock`) throw new Error("Remote callback requires its declared scope-owned path and Unix UID");
    const parent = lstatSync(dirname(dirname(path))), directory = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o777) !== 0o755 || !directory.isDirectory() || directory.uid !== ownerUid || (directory.mode & 0o777) !== 0o755) throw new Error("Core callback directories must be prepared by the host under protected root and scope custody");
    unlock = acquireGatewaySocketOwner(path, ownerUid);
    await recoverGatewaySocket(path, ownerUid);
    const binding: GatewayBinding = { gatewayId: `remote-${config.scopeId}`, purpose: "remote-callback", peerUid: config.coreUid, principalId: config.principalId, scopeIds: [config.scopeId], routeCeiling: coreCallbackRoutes() };
    transport = createGatewayServer(binding, (incoming, outgoing) => {
      const abort = new AbortController();
      outgoing.once("close", () => abort.abort("Core disconnected"));
      const request = webRequest(incoming, config.url, AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]), "stream");
      void handleCoreCallback(request, config, callbacks).then(response => writeResponse(response, outgoing)).catch(cause => {
        if (!outgoing.headersSent) outgoing.writeHead(503, { "content-type": "application/json" });
        if (!outgoing.destroyed) outgoing.end(JSON.stringify({ ok: false, error: { code: "unavailable", message: `Core callback outcome unconfirmed: ${String(cause)}; retain original request identity` } }));
      });
    });
    await new Promise<void>((done, reject) => { const server = transport!.server; server.once("error", reject); server.listen(path, () => { server.off("error", reject); done(); }); });
    identity = lstatSync(path, { bigint: true });
    chmodSync(path, 0o600);
    return { ok: true, value: { close } };
  } catch (cause) {
    let message = `Core callback listener unavailable: ${String(cause)}`;
    try { await close(); } catch (cleanup) { message += `; callback custody cleanup failed: ${String(cleanup)}`; }
    return { ok: false, error: { code: "unavailable", message } };
  }
}
