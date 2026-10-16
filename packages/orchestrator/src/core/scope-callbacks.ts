import type { CoreScope } from "./contracts.js";
import type { CoreResult } from "./config.js";
import type { GatewayPeer } from "./gateway-fetch.js";

export const CALLBACK_SOURCE_SCOPE = "x-pi-core-callback-source";
export const CALLBACK_TARGET_SCOPE = "x-pi-core-callback-target";
export const CALLBACK_PRINCIPAL = "x-pi-core-callback-principal";
const invalid = (message: string): CoreResult<never> => ({ ok: false, error: { code: "invalid-config", message } });
const unavailable = (message: string): CoreResult<never> => ({ ok: false, error: { code: "unavailable", message } });
const sameSubjects = (left: readonly string[], right: readonly string[]) => {
  const sorted = [...right].sort();
  return left.length === right.length && [...left].sort().every((subject, index) => subject === sorted[index]);
};

function sharedTarget(scopes: readonly CoreScope[], source: CoreScope): CoreResult<CoreScope> {
  const callback = source.callbackGateway;
  if (callback.kind !== "shared-remote-callback") return invalid("Shared callback declaration is unset");
  const target = scopes.find(scope => scope.id === callback.targetScopeId);
  if (!target || target === source || target.id === source.id) return invalid(`Scope ${source.id} has no distinct registered Remote callback target`);
  if (source.principalId !== target.principalId || source.resource.owner !== target.resource.owner || source.resource.privacy !== target.resource.privacy || !sameSubjects(source.resource.subjects, target.resource.subjects)
    || source.custody.uid !== target.custody.uid || source.custody.gid !== target.custody.gid || callback.peerUid !== target.custody.uid) return invalid(`Scope ${source.id} callback crosses its registered owner, principal or custody boundary`);
  if (target.callbackGateway.kind === "shared-remote-callback") return invalid(`Scope ${source.id} callback cannot chain through another shared target`);
  if (target.callbackGateway.kind === "none") {
    return target.availability.kind === "unavailable" ? { ok: true, value: target } : invalid(`Scope ${source.id} callback target has no adopted Remote adapter`);
  }
  if (target.callbackGateway.peerUid !== callback.peerUid) return invalid(`Scope ${source.id} callback target has another kernel peer`);
  if (target.availability.kind === "adopt" && (!target.environment.PI_REMOTE_SERVER_URL || source.environment.PI_REMOTE_SERVER_URL !== target.environment.PI_REMOTE_SERVER_URL)) return invalid(`Scope ${source.id} callback does not name the target's exact Remote origin`);
  return { ok: true, value: target };
}

export function validateScopeCallbacks(scopes: readonly CoreScope[]): CoreResult<void> {
  for (const source of scopes) if (source.callbackGateway.kind === "shared-remote-callback") {
    const target = sharedTarget(scopes, source);
    if (!target.ok) return target;
  }
  return { ok: true, value: undefined };
}

export function scopeCallbackTarget(scopes: readonly CoreScope[], source: CoreScope): CoreResult<{ scopeId: string; peerUid: number; socketPath: string }> {
  if (source.callbackGateway.kind === "none") return unavailable(`Scope ${source.id} callback is unset`);
  const selected = source.callbackGateway.kind === "shared-remote-callback" ? sharedTarget(scopes, source) : { ok: true as const, value: source };
  if (!selected.ok) return selected;
  const target = selected.value;
  if (source.availability.kind === "unavailable" || target.availability.kind === "unavailable") return unavailable(`Scope ${source.id} callback is paused while its registered Remote target is unavailable`);
  if (target.callbackGateway.kind !== "remote-callback") return unavailable(`Scope ${source.id} callback target is not serving a Remote adapter`);
  return { ok: true, value: { scopeId: target.id, peerUid: target.callbackGateway.peerUid, socketPath: `/run/pi-stack/gateways/remote-${target.id}/callback.sock` } };
}

export type ScopeCallbackFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export function scopeCallbackTransport(scopes: readonly CoreScope[], source: CoreScope, forward: (peer: GatewayPeer, input: string | URL | Request, init?: RequestInit) => Promise<Response>): ScopeCallbackFetch {
  return async (input, init) => {
    const target = scopeCallbackTarget(scopes, source);
    if (!target.ok) return Response.json({ ok: false, error: { code: "unavailable", message: target.error.message } }, { status: 503 });
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const name of [CALLBACK_SOURCE_SCOPE, CALLBACK_TARGET_SCOPE, CALLBACK_PRINCIPAL]) headers.delete(name);
    if (source.callbackGateway.kind === "shared-remote-callback") {
      headers.set(CALLBACK_SOURCE_SCOPE, source.id);
      headers.set(CALLBACK_TARGET_SCOPE, target.value.scopeId);
      headers.set(CALLBACK_PRINCIPAL, source.principalId);
    }
    return forward({ socketPath: target.value.socketPath, peerUid: target.value.peerUid }, input, { ...init, headers });
  };
}

/** Read source attestation only after the consumer has verified its kernel peer. */
export function remoteCallbackSource(request: Request, expected: { scopeId: string; principalId: string }): CoreResult<string> {
  const source = request.headers.get(CALLBACK_SOURCE_SCOPE), target = request.headers.get(CALLBACK_TARGET_SCOPE), principal = request.headers.get(CALLBACK_PRINCIPAL);
  if (source === null && target === null && principal === null) return { ok: true, value: expected.scopeId };
  if (!source || !/^[a-zA-Z0-9_.:-]+$/.test(source) || [".", ".."].includes(source) || source === expected.scopeId || target !== expected.scopeId || principal !== expected.principalId) return unavailable("Shared callback does not name the verified source principal and target scope");
  return { ok: true, value: source };
}
