import { existsSync, readFileSync } from "node:fs";
import type { Person } from "./persons";
import type { EnvironmentEndpoint as PublicEndpoint } from "./protocol";

export type EnvironmentEndpoint = PublicEndpoint & { upstreams?: Record<string, string> };

export function ownEnvironment(environment: Record<string, unknown> = process.env) {
  return { id: String(environment.PI_REMOTE_ENVIRONMENT_ID ?? "local"), name: String(environment.PI_REMOTE_ENVIRONMENT_NAME ?? "Local"), baseUrl: "" };
}

export function configuredEnvironments(
  environment: Record<string, unknown> = process.env,
  hostFile = process.env.PI_STACK_HOST_FILE ?? "/etc/pi-stack/host.json",
): EnvironmentEndpoint[] {
  const own = ownEnvironment(environment);
  const declared = existsSync(hostFile) ? JSON.parse(readFileSync(hostFile, "utf8")).environments : undefined;
  if (declared === undefined) return [own];
  if (!Array.isArray(declared) || declared.length === 0) throw new Error(`${hostFile}: environments must be a non-empty list`);
  const ids = new Set<string>();
  const endpoints = declared.map((entry: any): EnvironmentEndpoint => {
    if (!entry || !/^[a-z][a-z0-9-]{0,31}$/.test(entry.id) || ids.has(entry.id)) throw new Error(`${hostFile}: environments requires unique lowercase ids`);
    ids.add(entry.id);
    if (entry.baseUrl !== undefined) throw new Error(`${hostFile}: remove baseUrl; the router generates authenticated endpoint paths`);
    if (entry.icon !== undefined && (typeof entry.icon !== "string" || !/^[a-z][a-z0-9-]*$/.test(entry.icon))) throw new Error(`${hostFile}: icon must be a web asset name`);
    if (entry.id === own.id) {
      if (entry.upstreams !== undefined) throw new Error(`${hostFile}: the local endpoint cannot have upstreams`);
    } else {
      if (!entry.upstreams || typeof entry.upstreams !== "object" || Array.isArray(entry.upstreams) || !Object.keys(entry.upstreams).length) throw new Error(`${hostFile}: remote endpoint ${entry.id} needs per-person upstreams`);
      for (const [user, target] of Object.entries(entry.upstreams)) {
        if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || typeof target !== "string") throw new Error(`${hostFile}: invalid upstream for ${entry.id}`);
        const url = new URL(target);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error(`${hostFile}: upstream must be an HTTP(S) origin without credentials`);
      }
    }
    return {
      id: entry.id, name: String(entry.name ?? entry.id),
      ...(entry.icon ? { icon: entry.icon } : {}),
      baseUrl: entry.id === own.id ? "" : `/v1/remotes/${entry.id}`,
      ...(entry.upstreams ? { upstreams: Object.fromEntries(Object.entries(entry.upstreams).map(([user, url]) => [user, String(url).replace(/\/$/, "")])) } : {}),
    };
  });
  if (!ids.has(own.id)) throw new Error(`${hostFile}: environments must include local endpoint ${own.id}`);
  return endpoints;
}

export function personEnvironments(person: Person, endpoints: EnvironmentEndpoint[], ownId: string): EnvironmentEndpoint[] {
  const grants = person.remoteAccess ?? [ownId];
  for (const id of grants) {
    const endpoint = endpoints.find((candidate) => candidate.id === id);
    if (!endpoint) throw new Error(`${person.user}: remoteAccess names unknown endpoint ${id}`);
    if (id !== ownId && (!person.unlock || !endpoint.upstreams?.[person.user])) throw new Error(`${person.user}: ${id} requires folder identity proof and a per-person upstream`);
  }
  if (!grants.includes(ownId)) throw new Error(`${person.user}: remoteAccess must include local endpoint ${ownId}`);
  return endpoints.filter((endpoint) => grants.includes(endpoint.id));
}

export function publicEnvironments(endpoints: EnvironmentEndpoint[]) {
  return endpoints.map(({ id, name, icon, baseUrl }) => ({ id, name, ...(icon ? { icon } : {}), baseUrl }));
}
