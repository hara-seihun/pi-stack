import type { Person } from "./persons";
import type { EnvironmentEndpoint } from "./environments";

/** Canonical manager environment owns effects too; the request cannot choose another host or person. */
export async function handleAgentActions(req: Request, peer: { uid: number } | undefined, people: ReadonlyMap<number, string>, person: (user: string) => Person | undefined,
  endpoints: (user: string) => readonly EnvironmentEndpoint[], localEnvironment: string,
  proxy: (person: Person, origin: string, req: Request, target: URL, upstream: string | undefined, sourceEnvironment: string) => Promise<Response>): Promise<Response> {
  const user = peer && people.get(peer.uid);
  const owner = user ? person(user) : undefined;
  const denied = (message: string, status: number) => Response.json({ ok: false, error: "unavailable", message }, { status });
  if (!owner) return denied("External actions require the registered local owning Unix identity", 403);
  if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/external-actions") return denied("Unknown external action authority route", 404);
  const canonical = owner.environment.PI_REMOTE_MANAGER_ENVIRONMENT ?? localEnvironment;
  if (typeof canonical !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(canonical)) return denied("Canonical action-owner environment is invalid", 503);
  const endpoint = endpoints(owner.user).find(item => item.id === canonical);
  const origin = canonical === localEnvironment ? `http://127.0.0.1:${owner.port}` : endpoint?.upstreams?.[owner.user];
  if (!endpoint || !origin) return denied("Canonical action-owner environment is not granted/reachable; no local ledger fallback", 503);
  return proxy(owner, origin, req, new URL("/v1/external-actions", origin), canonical === localEnvironment ? undefined : canonical, localEnvironment);
}
