import { randomBytes } from "node:crypto";

type Session = { user: string; expires: number; controller: AbortController };

export class RouterSessions {
  private sessions = new Map<string, Session>();
  constructor(private lifetimeMs = 30 * 24 * 60 * 60 * 1000) {}

  issue(user: string): string {
    this.prune();
    const existing = [...this.sessions].filter(([, session]) => session.user === user);
    for (const [token, session] of existing.slice(0, Math.max(0, existing.length - 31))) {
      session.controller.abort();
      this.sessions.delete(token);
    }
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { user, expires: Date.now() + this.lifetimeMs, controller: new AbortController() });
    return token;
  }

  get(token: string | null): { user: string; signal: AbortSignal } | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expires <= Date.now()) {
      session.controller.abort();
      this.sessions.delete(token);
      return null;
    }
    return { user: session.user, signal: session.controller.signal };
  }

  revoke(user: string) {
    for (const [token, session] of this.sessions) {
      if (session.user !== user) continue;
      session.controller.abort();
      this.sessions.delete(token);
    }
  }

  private prune() {
    for (const token of this.sessions.keys()) this.get(token);
  }
}
