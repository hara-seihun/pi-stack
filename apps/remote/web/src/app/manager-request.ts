import { API } from "../../../server/api";
import { validateManagerView } from "../../../shared/state-validation";
import type { Endpoint } from "../router-auth";
import type { ManagerPreference } from "./mono";

type ManagerError = { kind: "request_failed" | "invalid_response" | "owner_unavailable" | "identity_changed"; message: string };
export type ManagerResult = { ok: true; value: ManagerPreference } | { ok: false; error: ManagerError };
type ManagerTransport = {
  identity(): { user: string; session: string };
  environments(): Promise<Endpoint[]>;
  headers(initial: HeadersInit): Headers;
  fetch(url: string, options: RequestInit): Promise<Response>;
  clearSession(session: string): void;
};

export function createManagerRequest(transport: ManagerTransport) {
  return async (ownerEnvironmentId: string, change?: { view: "classic" | "mono"; hintSeen?: boolean }, signal?: AbortSignal): Promise<ManagerResult> => {
    const { user, session } = transport.identity();
    const currentIdentity = () => {
      const current = transport.identity();
      return user === current.user && session === current.session && !signal?.aborted;
    };
    try {
      const endpoints = await transport.environments();
      if (!currentIdentity()) return { ok: false, error: { kind: "identity_changed", message: "Manager request owner changed" } };
      const owner = endpoints.find(endpoint => endpoint.id === ownerEnvironmentId);
      if (!owner) return { ok: false, error: { kind: "owner_unavailable", message: `Manager environment is not available: ${ownerEnvironmentId}` } };
      const response = await transport.fetch(`${owner.baseUrl}${API.manager.path()}`, {
        method: change ? API.updateManager.method : API.manager.method,
        headers: transport.headers({ accept: "application/json", ...(change ? { "content-type": "application/json" } : {}) }),
        ...(change ? { body: JSON.stringify(change) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(change ? 20_000 : 5_000)]) : AbortSignal.timeout(change ? 20_000 : 5_000),
        cache: "no-store", redirect: "error",
      });
      const value: unknown = await response.json();
      if (!currentIdentity()) return { ok: false, error: { kind: "identity_changed", message: "Manager request owner changed" } };
      if (!response.ok) {
        if (response.status === 423) transport.clearSession(session);
        return { ok: false, error: { kind: "request_failed", message: `Manager environment returned HTTP ${response.status}` } };
      }
      try { validateManagerView(value); }
      catch (cause) { return { ok: false, error: { kind: "invalid_response", message: cause instanceof Error ? cause.message : "Invalid manager preference" } }; }
      if (change && (value.view !== change.view || change.hintSeen === true && !value.hintSeen)) {
        return { ok: false, error: { kind: "invalid_response", message: "Conversation view owner did not save the requested preference" } };
      }
      return { ok: true, value };
    } catch (cause) {
      return { ok: false, error: { kind: currentIdentity() ? "request_failed" : "identity_changed", message: cause instanceof Error ? cause.message : "Manager request failed" } };
    }
  };
}
