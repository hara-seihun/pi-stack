import { randomBytes } from "node:crypto";
import type { Person } from "./persons";
import type { RouterSessions } from "./router-sessions";

const COOKIE = "pi-editor-session";
type Grant = { user: string; session: string; controller: AbortController; timer: ReturnType<typeof setTimeout> };
type Ticket = { user: string; session: string; location: string; expires: number };
export type EditorIdentity = { ok: true; user: string; signal: AbortSignal } | { ok: false; status: 403 | 423; error: string };

export function editorSocket(user: string): string { return `/run/pi-editor/${user}/http.sock`; }
export function editorCookie(req: Request): string | null {
  const cookies = (req.headers.get("cookie") ?? "").split(";").map(value => value.trim());
  const matches = cookies.filter(value => value.startsWith(`${COOKIE}=`));
  return matches.length === 1 ? matches[0]!.slice(COOKIE.length + 1) : null;
}
export function editorOriginAllowed(req: Request, person: Person): boolean {
  const origin = req.headers.get("origin");
  return Boolean(person.editor && origin === person.editor.origin);
}

export class EditorAccess {
  private tickets = new Map<string, Ticket>();
  private grants = new Map<string, Grant>();
  constructor(private sessions: RouterSessions) {}

  issue(person: Person, session: string, path: string | null, kind: "file" | "directory"): { ok: true; url: string; ticket: string } | { ok: false; error: string } {
    const identity = this.sessions.get(session);
    if (!person.editor || !identity || identity.user !== person.user) return { ok: false, error: "Editor session unavailable" };
    for (const [token, ticket] of this.tickets) if (ticket.expires <= Date.now()) this.tickets.delete(token);
    const ticket = randomBytes(32).toString("base64url");
    const location = new URL("/", person.editor.origin);
    location.searchParams.set(kind === "file" ? "file" : "folder", path ?? person.editor.workspace);
    this.tickets.set(ticket, { user: person.user, session, location: `${location.pathname}${location.search}`, expires: Date.now() + 30_000 });
    return { ok: true, url: new URL("/editor/open", person.editor.origin).href, ticket };
  }

  consume(person: Person, ticket: string): { ok: true; location: string; cookie: string } | { ok: false; error: string } {
    const pending = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!pending || pending.expires <= Date.now() || pending.user !== person.user) return { ok: false, error: "Editor handoff expired or belongs to another person" };
    const identity = this.sessions.get(pending.session);
    if (!person.editor || !identity || identity.user !== person.user) return { ok: false, error: "Editor session ended" };
    this.close(pending.session);
    const token = randomBytes(32).toString("base64url");
    const controller = new AbortController();
    const dispose = () => { controller.abort(); clearTimeout(timer); this.grants.delete(token); identity.signal.removeEventListener("abort", dispose); };
    const timer = setTimeout(dispose, 8 * 60 * 60 * 1000);
    timer.unref();
    controller.signal.addEventListener("abort", () => identity.signal.removeEventListener("abort", dispose), { once: true });
    identity.signal.addEventListener("abort", dispose, { once: true });
    this.grants.set(token, { user: person.user, session: pending.session, controller, timer });
    if (identity.signal.aborted) dispose();
    return { ok: true, location: pending.location, cookie: `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${person.editor.origin.startsWith("https:") ? "; Secure" : ""}` };
  }

  authenticate(person: Person, req: Request): EditorIdentity {
    const token = editorCookie(req);
    const grant = token ? this.grants.get(token) : undefined;
    if (!grant) return { ok: false, status: 423, error: "Open your editor from Files in Pi Stack" };
    if (grant.user !== person.user) return { ok: false, status: 403, error: "Editor belongs to another person" };
    const identity = this.sessions.get(grant.session);
    if (!identity || identity.user !== person.user || grant.controller.signal.aborted) {
      this.close(grant.session);
      return { ok: false, status: 423, error: "Editor session ended" };
    }
    return { ok: true, user: person.user, signal: grant.controller.signal };
  }

  close(session: string): void {
    for (const [token, grant] of this.grants) {
      if (grant.session !== session) continue;
      clearTimeout(grant.timer);
      grant.controller.abort();
      this.grants.delete(token);
    }
    for (const [token, ticket] of this.tickets) if (ticket.session === session) this.tickets.delete(token);
  }
}
