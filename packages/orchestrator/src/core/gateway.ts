import type { IncomingMessage } from "node:http";
import type { Principal } from "../permissions.js";
import type { CoreResult } from "./config.js";

export type GatewayRoute = { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; kind: "exact" | "prefix"; path: string };
export type GatewayBinding = { gatewayId: string; purpose: "core-ingress" | "remote-callback"; peerUid: number; principalId: string; scopeIds: string[]; routeCeiling: GatewayRoute[] };
export type GatewayTransportConfig = { kind: "none" } | { kind: "unix"; socketDir: string };
const sockets = new WeakMap<object, GatewayBinding>();
const requests = new WeakMap<Request, GatewayBinding>();
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const denied = (message: string): CoreResult<never> => ({ ok: false, error: { code: "unavailable", message } });
export function parseGatewayConfig(transport: unknown, bindings: unknown, principals: readonly Principal[], scopes: readonly { id: string; principalId: string }[]): CoreResult<{ transport: GatewayTransportConfig; bindings: GatewayBinding[] }> {
  const invalid = (): CoreResult<never> => ({ ok: false, error: { code: "invalid-config", message: "Gateways require explicit kernel-peer Unix transport, registered principals/scopes and exact route ceilings" } });
  if (!object(transport) || !Array.isArray(bindings)) return invalid();
  if (transport.kind === "none" && Object.keys(transport).length === 1 && bindings.length === 0) return { ok: true, value: { transport: { kind: "none" }, bindings: [] } };
  if (transport.kind !== "unix" || transport.socketDir !== "/run/pi-stack/gateways" || !bindings.length) return invalid();
  const ids = new Set<string>();
  for (const binding of bindings) {
    if (!object(binding) || binding.purpose !== "core-ingress" || typeof binding.gatewayId !== "string" || !/^[a-zA-Z0-9_.:-]+$/.test(binding.gatewayId) || ids.has(binding.gatewayId)
      || !Number.isSafeInteger(binding.peerUid) || Number(binding.peerUid) < 0 || !principals.some(principal => principal.id === binding.principalId)
      || !Array.isArray(binding.scopeIds) || !binding.scopeIds.length || new Set(binding.scopeIds).size !== binding.scopeIds.length
      || binding.scopeIds.some(id => !scopes.some(scope => scope.id === id && scope.principalId === binding.principalId))
      || !Array.isArray(binding.routeCeiling) || !binding.routeCeiling.length) return invalid();
    for (const route of binding.routeCeiling) {
      if (!object(route) || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(route.method)) || !["exact", "prefix"].includes(String(route.kind))
        || typeof route.path !== "string" || /[?#\\\0\r\n]/.test(route.path) || route.path.includes("//") || route.path.includes("%")
        || route.path.split("/").some(part => part === "." || part === "..") || route.kind === "prefix" && !route.path.endsWith("/")) return invalid();
      const match = /^\/v1\/scopes\/([^/]+)\/(projection|events|update|thread-owner(?:\/.*)?|images(?:\/.*)?)$/.exec(route.path);
      const providerAnalytics = route.kind === "exact" && route.method === "GET" && ["/v1/providers/people-usage", "/v1/model-broker/v1/usage"].includes(route.path);
      if (!(match && binding.scopeIds.includes(match[1])) && !providerAnalytics) return invalid();
    }
    ids.add(binding.gatewayId);
  }
  return { ok: true, value: { transport: transport as GatewayTransportConfig, bindings: bindings as GatewayBinding[] } };
}
export function assertGatewayRequest(binding: GatewayBinding, request: Pick<Request, "method" | "url">): CoreResult<void> {
  let path: string;
  try {
    path = new URL(request.url).pathname;
    const scoped = /^\/v1\/scopes\/([^/]+)(\/.*)$/.exec(path);
    if (scoped) {
      const scope = decodeURIComponent(scoped[1]!);
      if (!/^[a-zA-Z0-9_.:-]+$/.test(scope) || scope === "." || scope === "..") return denied("Invalid gateway scope identifier");
      path = `/v1/scopes/${scope}${scoped[2]}`;
    }
  } catch { return denied("Invalid gateway route"); }
  return binding.routeCeiling.some(route => route.method === request.method && (route.kind === "exact" ? route.path === path : path.startsWith(route.path)))
    ? { ok: true, value: undefined } : denied("Request exceeds the verified gateway route ceiling");
}
export function admitGatewayPeer(binding: GatewayBinding, peer: { uid: number }): CoreResult<void> {
  return peer.uid === binding.peerUid ? { ok: true, value: undefined } : denied("Kernel peer does not own this gateway binding");
}
export function registerGatewaySocket(socket: object, binding: GatewayBinding, peer: { uid: number }): CoreResult<void> {
  const admission = admitGatewayPeer(binding, peer);
  if (admission.ok) sockets.set(socket, binding);
  return admission;
}
export function bindGatewayRequest(incoming: IncomingMessage, request: Request): CoreResult<void> {
  const binding = sockets.get(incoming.socket);
  if (!binding) return { ok: true, value: undefined };
  requests.set(request, binding);
  return assertGatewayRequest(binding, request);
}
export function gatewayAuthority(request: Request): GatewayBinding | null { return requests.get(request) ?? null; }
export function inheritGatewayAuthority(source: Request, target: Request): void {
  const binding = requests.get(source); if (binding) requests.set(target, binding);
}
export function intersectGatewayAuthority(binding: GatewayBinding, authority: { principalId: string; scopeIds: readonly string[] }): CoreResult<{ principalId: string; scopeIds: string[] }> {
  if (authority.principalId !== binding.principalId) return denied("Gateway and native capability name different principals");
  const scopeIds = authority.scopeIds.filter(scopeId => binding.scopeIds.includes(scopeId));
  return scopeIds.length ? { ok: true, value: { principalId: binding.principalId, scopeIds } } : denied("Native capability exceeds the gateway scope ceiling");
}
