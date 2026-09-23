import * as oidc from "openid-client";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  publicUrl: string;
  allowedEmailDomains: string[];
  subjectPrefix: string;
  authorizationParameters?: Record<string, string>;
  provisionCommand: string[];
}
export interface OidcIdentity {
  version: 1;
  issuer: string;
  subject: string;
  email: string;
  emailVerified: true;
  displayName: string;
}
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
type Transaction = { verifier: string; nonce: string; binding: string; expires: number };

export function readOidcSettings(path = process.env.PI_REMOTE_OIDC_CONFIG): OidcSettings | null {
  if (!path) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as OidcSettings;
  for (const field of ["issuer", "publicUrl"] as const) {
    const url = new URL(value[field]);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(`OIDC ${field} must be an HTTPS URL without credentials, query or fragment`);
  }
  if (!value.publicUrl.endsWith("/") || !value.clientId || !value.clientSecret || !value.subjectPrefix ||
      !Array.isArray(value.allowedEmailDomains) || !value.allowedEmailDomains.length ||
      value.allowedEmailDomains.some(domain => !/^[a-z0-9.-]+$/.test(domain)) ||
      !Array.isArray(value.provisionCommand) || !value.provisionCommand.length ||
      value.provisionCommand.some(arg => typeof arg !== "string" || !arg) || !value.provisionCommand[0]!.startsWith("/")) {
    throw new Error("Invalid OIDC client, identity admission or provisioning configuration");
  }
  return value;
}

export function admittedIdentity(settings: OidcSettings, claims: Record<string, unknown> | undefined): Result<OidcIdentity> {
  if (!claims || claims.iss !== settings.issuer || typeof claims.sub !== "string" ||
      !claims.sub.startsWith(settings.subjectPrefix) || claims.sub.length > 256 ||
      claims.email_verified !== true || typeof claims.email !== "string" ||
      !/^[^@\s]+@[^@\s]+$/.test(claims.email) ||
      !settings.allowedEmailDomains.includes(claims.email.split("@")[1]!.toLowerCase())) {
    return { ok: false, error: "Sign in with a verified company Google account." };
  }
  return { ok: true, value: { version: 1, issuer: settings.issuer, subject: claims.sub,
    email: claims.email.toLowerCase(), emailVerified: true,
    displayName: typeof claims.name === "string" ? claims.name.slice(0, 160) : claims.email } };
}

export class OidcLogin {
  private configuration: Promise<oidc.Configuration> | undefined;
  private transactions = new Map<string, Transaction>();
  readonly callback: URL;
  readonly cookieName: string;
  readonly transactionCookie: string;
  constructor(readonly settings: OidcSettings) {
    this.callback = new URL("v1/auth/callback", settings.publicUrl);
    this.cookieName = `pi-oidc-${createHash("sha256").update(settings.publicUrl).digest("hex").slice(0, 12)}`;
    this.transactionCookie = `${this.cookieName}-login`;
  }
  private config() {
    this.configuration ??= oidc.discovery(new URL(this.settings.issuer), this.settings.clientId, this.settings.clientSecret, undefined, { timeout: 10 })
      .catch(error => { this.configuration = undefined; throw error; });
    return this.configuration;
  }
  cookie(name: string, value: string, seconds: number): string {
    return `${name}=${value}; Path=${new URL(this.settings.publicUrl).pathname}; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
  }
  readCookie(req: Request, name = this.cookieName): string | null {
    const matches = (req.headers.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
    return matches.length === 1 ? matches[0]!.slice(name.length + 1) : null;
  }
  async begin(): Promise<Result<{ location: string; cookie: string }>> {
    try {
      const config = await this.config();
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const binding = oidc.randomState();
      for (const [id, transaction] of this.transactions) if (transaction.expires <= Date.now()) this.transactions.delete(id);
      if (this.transactions.size >= 1024) return { ok: false, error: "Sign-in is busy. Please try again shortly." };
      this.transactions.set(state, { verifier, nonce, binding, expires: Date.now() + 600_000 });
      const location = oidc.buildAuthorizationUrl(config, { ...this.settings.authorizationParameters,
        redirect_uri: this.callback.href, scope: "openid email profile", response_type: "code",
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256", state, nonce });
      return { ok: true, value: { location: location.href, cookie: this.cookie(this.transactionCookie, binding, 600) } };
    } catch { return { ok: false, error: "The sign-in provider is unavailable. Please try again." }; }
  }
  async finish(req: Request): Promise<Result<OidcIdentity>> {
    const input = new URL(req.url);
    const state = input.searchParams.get("state") ?? "";
    const transaction = this.transactions.get(state);
    this.transactions.delete(state);
    const binding = this.readCookie(req, this.transactionCookie);
    if (!transaction || transaction.expires <= Date.now() || !binding || Buffer.byteLength(binding) !== Buffer.byteLength(transaction.binding) ||
        !timingSafeEqual(Buffer.from(binding), Buffer.from(transaction.binding))) {
      return { ok: false, error: "Sign-in expired or belongs to another browser. Please sign in again." };
    }
    try {
      const callback = new URL(this.callback);
      callback.search = input.search;
      const tokens = await oidc.authorizationCodeGrant(await this.config(), callback, {
        pkceCodeVerifier: transaction.verifier, expectedState: state, expectedNonce: transaction.nonce, idTokenExpected: true,
      });
      return admittedIdentity(this.settings, tokens.claims());
    } catch { return { ok: false, error: "The sign-in provider did not authenticate this request. Please sign in again." }; }
  }
  async provision(identity: OidcIdentity): Promise<Result<{ user: string; key: string }>> {
    try {
      const child = Bun.spawn(this.settings.provisionCommand, {
        stdin: new Blob([JSON.stringify(identity)]), stdout: "pipe", stderr: "pipe", timeout: 45_000,
      });
      const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) return { ok: false, error: "Your account could not be prepared. The host administrator can inspect provisioning logs." };
      const value = JSON.parse(output);
      if (!value || typeof value.user !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(value.user) || typeof value.key !== "string" || !value.key) {
        return { ok: false, error: "Account provisioning returned an invalid person." };
      }
      return { ok: true, value };
    } catch { return { ok: false, error: "Account provisioning did not complete. Please try signing in again." }; }
  }
}
