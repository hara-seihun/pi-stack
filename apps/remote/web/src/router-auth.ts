import type { EnvironmentEndpoint, HostAuthentication } from "../../server/protocol";

export interface RouterIdentity { user: string; session: string }
export type Endpoint = EnvironmentEndpoint;
type StorageAccess = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export class RouterAuth {
  private identity: RouterIdentity;
  authentication: HostAuthentication | null = null;
  constructor(private people: StorageAccess, private tab: StorageAccess, private changed: (kind: "person" | "auth") => void) {
    const user = people.getItem("pi-remote-person") || "";
    this.identity = { user, session: user ? tab.getItem(`pi-remote-session:${user}`) || "" : "" };
  }
  get user() { return this.identity.user; }
  get session() { return this.identity.session; }
  setPerson(user: string) {
    if (this.authentication && user !== this.user) throw new Error("This host uses your signed-in account");
    this.selectPerson(user);
  }
  restore(user: string, session: string) {
    if (!user || !session) throw new Error("Router returned an invalid sign-in session");
    this.selectPerson(user);
    this.accept(user, session);
  }
  private selectPerson(user: string) {
    if (user === this.user) return;
    this.clear();
    if (this.user) this.tab.removeItem(`pi-remote-environment:${this.user}`);
    if (user) {
      this.people.setItem("pi-remote-person", user);
      this.tab.removeItem(`pi-remote-session:${user}`);
      this.tab.removeItem(`pi-remote-environment:${user}`);
    } else this.people.removeItem("pi-remote-person");
    this.identity = { user, session: "" };
    this.changed("person");
  }
  accept(user: string, session: string) {
    if (!user || user !== this.user || !session) throw new Error("Unlock response does not match the selected person");
    this.identity = { user, session };
    this.tab.setItem(`pi-remote-session:${user}`, session);
    this.changed("auth");
  }
  clear(session = this.session) {
    if (!this.session || session !== this.session) return;
    if (this.user) this.tab.removeItem(`pi-remote-session:${this.user}`);
    this.identity = { user: this.user, session: "" };
    this.changed("auth");
  }
  headers(initial?: HeadersInit, includeSession = true) {
    const headers = new Headers(initial);
    const hint = headers.get("x-pi-remote-user");
    if (hint && hint !== this.user) throw new Error("Request person does not match the authenticated person");
    headers.delete("x-pi-remote-session");
    if (this.user) headers.set("x-pi-remote-user", this.user);
    if (includeSession && this.session) headers.set("x-pi-remote-session", this.session);
    return headers;
  }
}

export function routerApiPath(value: string, origin: string, prefixes = [""]): string | null {
  const url = new URL(value, origin);
  const base = new URL(origin);
  if (url.origin !== base.origin) return null;
  return prefixes.some(prefix => url.pathname.startsWith(`${prefix}/v1/`)) ? `${url.pathname}${url.search}${url.hash}` : null;
}

export function sessionUrl(value: string, origin: string, session: string, prefixes = [""]): string {
  if (!routerApiPath(value, origin, prefixes)) return value;
  const url = new URL(value, origin);
  url.searchParams.delete("user");
  url.searchParams.delete("session");
  if (session) url.searchParams.set("session", session);
  return /^https?:/.test(value) ? url.href : `${url.pathname}${url.search}${url.hash}`;
}

export function resolveEndpoints(value: unknown, bootstrap: string, origin: string): Endpoint[] {
  if (!Array.isArray(value)) throw new Error("Router did not return an endpoint list");
  const root = new URL(bootstrap || "/", origin);
  const ids = new Set<string>();
  return value.map(item => {
    if (!item || typeof item.id !== "string" || !item.id || typeof item.name !== "string" || typeof item.baseUrl !== "string" || ids.has(item.id)) throw new Error("Router returned an invalid endpoint");
    const prefix = item.baseUrl;
    if (prefix && (!prefix.startsWith("/") || prefix.startsWith("//") || /[?#\\]/.test(prefix) || prefix.split("/").some((part: string) => part === "." || part === ".." || /%/i.test(part)))) throw new Error("Endpoint must be a same-origin router prefix");
    ids.add(item.id);
    const baseUrl = `${bootstrap.replace(/\/$/, "")}${prefix.replace(/\/$/, "")}`;
    if (new URL(baseUrl || "/", origin).origin !== root.origin) throw new Error("Endpoint must use the bootstrap origin");
    return { id: item.id, name: item.name, baseUrl, ...(typeof item.icon === "string" ? { icon: item.icon } : {}) };
  });
}
