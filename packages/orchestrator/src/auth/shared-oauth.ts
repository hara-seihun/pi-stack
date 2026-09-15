import { custodyMkdirSync as mkdirSync, custodyOpenSync as openSync, custodyWriteFileSync as writeFileSync } from "../shared-custody.js";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ModelAuth, OAuthAuth, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { acquireDirectoryLock } from "./directory-lock.js";
import { aliasProvider } from "./provider-alias.js";
const TOKEN_MIN_LIFETIME_MS = 5 * 60_000;

type RefreshCredential = (credential: OAuthCredential, signal: AbortSignal) => Promise<OAuthCredential>;
type CredentialIdentity = (credential: OAuthCredential) => string | undefined;

export function defaultSharedAuthPath(ledgerPath: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_ORCHESTRATOR_AUTH !== undefined) return env.PI_ORCHESTRATOR_AUTH;
  try {
    return join(dirname(realpathSync(ledgerPath)), "auth.json");
  } catch {
    return join(dirname(ledgerPath), "auth.json");
  }
}

export interface SharedOAuthAuthOptions {
  readonly path: string;
  readonly providerId: string;
  readonly refresh: RefreshCredential;
  readonly toAuth: OAuthAuth["toAuth"];
  readonly identity?: CredentialIdentity;
  readonly now?: () => number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function oauthCredential(value: unknown): OAuthCredential | undefined {
  const raw = record(value);
  if (
    raw?.type !== "oauth" ||
    typeof raw.access !== "string" || raw.access.length === 0 ||
    typeof raw.refresh !== "string" || raw.refresh.length === 0 ||
    typeof raw.expires !== "number" || !Number.isFinite(raw.expires)
  ) return undefined;
  return raw as OAuthCredential;
}

function readAuth(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause: any) {
    if (cause?.code === "ENOENT") return {};
    throw cause;
  }
  const auth = record(parsed);
  if (auth === undefined) throw new Error(`Shared OAuth auth at ${path} is not a JSON object`);
  return auth;
}

function writeAuth(path: string, auth: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o770 });
  const temporary = join(dirname(path), `.auth.json.shared-${crypto.randomUUID()}`);
  writeFileSync(temporary, JSON.stringify(auth, null, 2), { encoding: "utf8", mode: 0o660 });
  chmodSync(temporary, 0o660);
  const fd = openSync(temporary, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function ensureAuth(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o770 });
  if (existsSync(path)) return;
  try {
    writeFileSync(path, "{}\n", { encoding: "utf8", mode: 0o660, flag: "wx" });
    chmodSync(path, 0o660);
  } catch (cause: any) {
    if (cause?.code !== "EEXIST") throw cause;
  }
}

function acquireLock(path: string, signal: AbortSignal): Promise<() => void> {
  ensureAuth(path);
  return acquireDirectoryLock(path, signal, "Timed out waiting for the shared OAuth auth lock");
}

export async function withSharedAuth<T>(path: string, signal: AbortSignal, effect: (auth: Record<string, unknown>, save: () => void) => T): Promise<T> {
  const release = await acquireLock(path, signal);
  try {
    const auth = readAuth(path);
    return effect(auth, () => writeAuth(path, auth));
  } finally { release(); }
}

function assertMutableCredential(value: unknown, alias: string): void {
  if (String(record(value)?.type ?? "").startsWith("account-transfer")) {
    throw new Error(`Account ${alias} belongs to an exclusive transfer; resume that transfer instead`);
  }
}

export async function transactSharedCredential<T>(path:string,alias:string,value:unknown,effect:()=>Promise<T>):Promise<T>{
  const release=await acquireLock(path,new AbortController().signal);
  try{
    const auth=readAuth(path);
    assertMutableCredential(auth[alias], alias);
    const previous={...auth};
    if(value===undefined)delete auth[alias];
    else{
      const credential=oauthCredential(value);
      if(credential===undefined)throw new Error(`Invalid OAuth credential for ${alias}`);
      auth[alias]=credential;
    }
    writeAuth(path,auth);
    try{return await effect();}
    catch(error){writeAuth(path,previous);throw error;}
  }finally{release();}
}

export class SharedOAuthAuth {
  readonly #path: string;
  readonly #providerId: string;
  readonly #refresh: RefreshCredential;
  readonly #toAuth: OAuthAuth["toAuth"];
  readonly #identity?: CredentialIdentity;
  readonly #now: () => number;

  constructor(options: SharedOAuthAuthOptions) {
    this.#path = options.path;
    this.#providerId = options.providerId;
    this.#refresh = options.refresh;
    this.#toAuth = options.toAuth;
    this.#identity = options.identity;
    this.#now = options.now ?? Date.now;
  }

  get path(): string {
    return this.#path;
  }

  aliases(): string[] {
    return Object.entries(readAuth(this.#path))
      .filter(([, value]) => oauthCredential(value) !== undefined)
      .map(([alias]) => alias)
      .sort();
  }

  has(alias: string): boolean {
    return oauthCredential(readAuth(this.#path)[alias]) !== undefined;
  }

  async credential(
    alias: string,
    signal: AbortSignal,
    minLifetimeMs = TOKEN_MIN_LIFETIME_MS,
  ): Promise<OAuthCredential> {
    const release = await acquireLock(this.#path, signal);
    try {
      const auth = readAuth(this.#path);
      const current = oauthCredential(auth[alias]);
      if (current === undefined) throw new Error(`${alias} has no shared ${this.#providerId} OAuth credential`);
      if (current.expires > this.#now() + minLifetimeMs) return current;
      const refreshed = oauthCredential(await this.#refresh(current, signal));
      if (refreshed === undefined) throw new Error(`${this.#providerId} OAuth refresh for ${alias} returned an invalid credential`);
      const oldIdentity = this.#identity?.(current);
      const newIdentity = this.#identity?.(refreshed);
      if (oldIdentity !== undefined && newIdentity !== oldIdentity) {
        throw new Error(`${this.#providerId} OAuth refresh for ${alias} changed account identity`);
      }
      auth[alias] = refreshed;
      writeAuth(this.#path, auth);
      return refreshed;
    } finally {
      release();
    }
  }

  /**
   * Replaces an access token the provider rejected, whatever its stated
   * expiry says.
   *
   * Expiry-driven refresh assumes the only way a token stops working is the
   * clock running out. OpenAI invalidates an account's issued access tokens
   * when its auth session rotates, so a credential with days of nominal life
   * left is answered `401 Provided authentication token is expired.` — and
   * `credential()` hands that same dead token to the next caller, and the
   * one after that, forever. On 2026-09-09 the `openai-codex` account sat
   * broken this way with a perfectly good refresh token: Pi Remote thread
   * naming, pinned to that account, silently left every new thread numbered,
   * and the usage meter logged 401 every five minutes without repairing
   * anything.
   *
   * The rejected token is named by the caller so this is compare-and-swap,
   * not a blind refresh: if another process already replaced the credential
   * while this request was in flight, its work stands and this caller simply
   * takes the newer token. Otherwise concurrent 401s from one account's
   * sessions would each spend a rotation of the refresh token and race over
   * which result lands in the file.
   */
  async refreshRejected(
    alias: string,
    rejectedAccessToken: string,
    signal: AbortSignal,
  ): Promise<OAuthCredential> {
    const release = await acquireLock(this.#path, signal);
    try {
      const auth = readAuth(this.#path);
      const current = oauthCredential(auth[alias]);
      if (current === undefined) throw new Error(`${alias} has no shared ${this.#providerId} OAuth credential`);
      if (current.access !== rejectedAccessToken) return current;
      const refreshed = oauthCredential(await this.#refresh(current, signal));
      if (refreshed === undefined) throw new Error(`${this.#providerId} OAuth refresh for ${alias} returned an invalid credential`);
      const oldIdentity = this.#identity?.(current);
      const newIdentity = this.#identity?.(refreshed);
      if (oldIdentity !== undefined && newIdentity !== oldIdentity) {
        throw new Error(`${this.#providerId} OAuth refresh for ${alias} changed account identity`);
      }
      auth[alias] = refreshed;
      writeAuth(this.#path, auth);
      return refreshed;
    } finally {
      release();
    }
  }

  async resolve(alias: string, signal: AbortSignal): Promise<ModelAuth> {
    return this.#toAuth(await this.credential(alias, signal));
  }

  async set(alias: string, value: OAuthCredential, signal = new AbortController().signal): Promise<void> {
    const credential = oauthCredential(value);
    if (credential === undefined) throw new Error(`Invalid ${this.#providerId} OAuth credential for ${alias}`);
    const release = await acquireLock(this.#path, signal);
    try {
      const auth = readAuth(this.#path);
      assertMutableCredential(auth[alias], alias);
      const identity = this.#identity?.(credential);
      if (identity !== undefined) {
        for (const [otherAlias, otherValue] of Object.entries(auth)) {
          const other = oauthCredential(otherValue);
          if (otherAlias !== alias && other !== undefined && this.#identity?.(other) === identity) {
            throw new Error(`${this.#providerId} account identity is already stored as ${otherAlias}`);
          }
        }
      }
      auth[alias] = credential;
      writeAuth(this.#path, auth);
    } finally {
      release();
    }
  }

  async remove(alias: string, signal = new AbortController().signal): Promise<void> {
    const release = await acquireLock(this.#path, signal);
    try {
      const auth = readAuth(this.#path);
      assertMutableCredential(auth[alias], alias);
      delete auth[alias];
      writeAuth(this.#path, auth);
    } finally {
      release();
    }
  }
}

export function dropLocalCredential(agentAuthPath: string, alias: string): boolean {
  let auth: Record<string, unknown>;
  try {
    auth = readAuth(agentAuthPath);
  } catch {
    return false;
  }
  if (!(alias in auth)) return false;
  assertMutableCredential(auth[alias], alias);
  delete auth[alias];
  writeAuth(agentAuthPath, auth);
  return true;
}

export function providerOAuth(family: Provider, path: string): SharedOAuthAuth {
  const oauth = family.auth.oauth;
  if (!oauth) throw new Error(`${family.id} has no OAuth provider`);
  return new SharedOAuthAuth({
    path,
    providerId: family.id,
    refresh: (credential, signal) => oauth.refresh(credential, signal),
    toAuth: (credential) => oauth.toAuth(credential),
    identity: family.id === "openai-codex"
      ? (credential) => typeof credential.accountId === "string" ? credential.accountId : undefined
      : undefined,
  });
}

export function sharedOAuthProvider(
  family: Provider,
  alias: string,
  label: string | undefined,
  auth: SharedOAuthAuth,
  onRequestToken?: (accessToken: string) => void,
): Provider {
  const authName = `Shared ${family.name} OAuth`;
  const provider = aliasProvider(family, alias, label, {
    apiKey: {
      name: authName,
      async check() {
        return auth.has(alias) ? { type: "oauth", source: "shared OAuth" } : undefined;
      },
      async resolve({ signal }) {
        return { auth: await auth.resolve(alias, signal), source: "shared OAuth" };
      },
    },
    oauth: {
      name: authName,
      isSubscription: family.auth.oauth?.isSubscription,
      async login(): Promise<never> {
        throw new Error(
          `${alias} is in shared custody: log in with \`pi-orchestrator account login ${alias}\``,
        );
      },
      refresh: (_credential, signal) => auth.credential(alias, signal),
      toAuth: () => auth.resolve(alias, new AbortController().signal),
    },
  });
  return {
    ...provider,
    stream(model, context, options) {
      if (options?.apiKey) onRequestToken?.(options.apiKey);
      return provider.stream(model, context, options);
    },
    streamSimple(model, context, options) {
      if (options?.apiKey) onRequestToken?.(options.apiKey);
      return provider.streamSimple(model, context, options);
    },
  };
}
