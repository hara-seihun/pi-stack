import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ModelAuth, OAuthAuth, OAuthCredential, Provider } from "@earendil-works/pi-ai";

const LOCK_STALE_MS = 30_000;
const TOKEN_MIN_LIFETIME_MS = 5 * 60_000;

export type CodexCredential = OAuthCredential & { readonly accountId: string };

type RefreshCredential = (credential: CodexCredential, signal: AbortSignal) => Promise<OAuthCredential>;

export function defaultSharedCodexAuthPath(ledgerPath: string): string {
  if (process.env.PI_ORCHESTRATOR_AUTH !== undefined) return process.env.PI_ORCHESTRATOR_AUTH;
  try {
    return join(dirname(realpathSync(ledgerPath)), "auth.json");
  } catch {
    return join(dirname(ledgerPath), "auth.json");
  }
}

export interface SharedCodexAuthOptions {
  readonly path: string;
  readonly refresh: RefreshCredential;
  readonly toAuth: OAuthAuth["toAuth"];
  readonly now?: () => number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function codexCredential(value: unknown): CodexCredential | undefined {
  const raw = record(value);
  if (
    raw?.type !== "oauth" ||
    typeof raw.access !== "string" || raw.access.length === 0 ||
    typeof raw.refresh !== "string" || raw.refresh.length === 0 ||
    typeof raw.expires !== "number" || !Number.isFinite(raw.expires) ||
    typeof raw.accountId !== "string" || raw.accountId.length === 0
  ) return undefined;
  return raw as CodexCredential;
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
  if (auth === undefined) throw new Error(`Shared Codex auth at ${path} is not a JSON object`);
  return auth;
}

function writeAuth(path: string, auth: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o770 });
  const temporary = join(dirname(path), `.auth.json.shared-${crypto.randomUUID()}`);
  writeFileSync(temporary, JSON.stringify(auth, null, 2), { encoding: "utf8", mode: 0o660 });
  chmodSync(temporary, 0o660);
  renameSync(temporary, path);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function acquireLock(path: string, signal: AbortSignal): Promise<() => void> {
  ensureAuth(path);
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_STALE_MS;
  while (true) {
    signal.throwIfAborted();
    try {
      mkdirSync(lockPath, { mode: 0o770 });
      const heartbeat = setInterval(() => {
        try {
          const time = new Date();
          utimesSync(lockPath, time, time);
        } catch {}
      }, 10_000);
      return () => {
        clearInterval(heartbeat);
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {}
      };
    } catch (cause: any) {
      if (cause?.code !== "EEXIST") throw cause;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the shared Codex auth lock");
      await sleep(25 + Math.floor(Math.random() * 75));
    }
  }
}

export class SharedCodexAuth {
  readonly #path: string;
  readonly #refresh: RefreshCredential;
  readonly #toAuth: OAuthAuth["toAuth"];
  readonly #now: () => number;

  constructor(options: SharedCodexAuthOptions) {
    this.#path = options.path;
    this.#refresh = options.refresh;
    this.#toAuth = options.toAuth;
    this.#now = options.now ?? Date.now;
  }

  get path(): string {
    return this.#path;
  }

  aliases(): string[] {
    return Object.entries(readAuth(this.#path))
      .filter(([, value]) => codexCredential(value) !== undefined)
      .map(([alias]) => alias)
      .sort();
  }

  has(alias: string): boolean {
    return codexCredential(readAuth(this.#path)[alias]) !== undefined;
  }

  async credential(
    alias: string,
    signal: AbortSignal,
    minLifetimeMs = TOKEN_MIN_LIFETIME_MS,
  ): Promise<CodexCredential> {
    const release = await acquireLock(this.#path, signal);
    try {
      const auth = readAuth(this.#path);
      const current = codexCredential(auth[alias]);
      if (current === undefined) throw new Error(`${alias} has no shared Codex OAuth credential`);
      if (current.expires > this.#now() + minLifetimeMs) return current;
      const refreshed = codexCredential(await this.#refresh(current, signal));
      if (refreshed === undefined) throw new Error(`Codex OAuth refresh for ${alias} returned an invalid credential`);
      if (refreshed.accountId !== current.accountId) {
        throw new Error(`Codex OAuth refresh for ${alias} changed account identity`);
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
    const credential = codexCredential(value);
    if (credential === undefined) throw new Error(`Invalid Codex OAuth credential for ${alias}`);
    const release = await acquireLock(this.#path, signal);
    try {
      const auth = readAuth(this.#path);
      for (const [otherAlias, otherValue] of Object.entries(auth)) {
        if (otherAlias !== alias && codexCredential(otherValue)?.accountId === credential.accountId) {
          throw new Error(`Codex account identity is already stored as ${otherAlias}`);
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
      delete auth[alias];
      writeAuth(this.#path, auth);
    } finally {
      release();
    }
  }
}

/**
 * Custody is a move, not a copy: once an alias is served from the shared
 * store, the per-user copy is a second source of truth for the same secret
 * and is deleted. Returns whether one was there.
 */
export function dropLocalCredential(agentAuthPath: string, alias: string): boolean {
  let auth: Record<string, unknown>;
  try {
    auth = readAuth(agentAuthPath);
  } catch {
    return false;
  }
  if (!(alias in auth)) return false;
  delete auth[alias];
  writeAuth(agentAuthPath, auth);
  return true;
}

export function sharedCodexProvider(
  family: Provider,
  alias: string,
  label: string | undefined,
  auth: SharedCodexAuth,
): Provider {
  return {
    id: alias,
    name: label === undefined ? `${family.name} [${alias}]` : `${family.name} [${label}]`,
    baseUrl: family.baseUrl,
    headers: family.headers,
    auth: {
      apiKey: {
        name: "Shared OpenAI Codex OAuth",
        async check() {
          return auth.has(alias) ? { type: "oauth", source: "shared OAuth" } : undefined;
        },
        async resolve({ signal }) {
          return { auth: await auth.resolve(alias, signal), source: "shared OAuth" };
        },
      },
      // A credential stored under this alias in a per-user auth.json owns the
      // provider as far as the SDK's resolver is concerned: with no oauth
      // branch here it would resolve to nothing at all ("No API key found"),
      // and with the family's branch it would rotate the shared refresh token
      // from a stale copy. Both are answered by making shared custody the
      // only source of tokens, whatever a leftover per-user copy holds.
      oauth: {
        name: "Shared OpenAI Codex OAuth",
        isSubscription: family.auth.oauth?.isSubscription,
        async login(): Promise<never> {
          throw new Error(
            `${alias} is in shared custody: log in with \`pi-orchestrator account login ${alias}\``,
          );
        },
        refresh: (_credential, signal) => auth.credential(alias, signal),
        toAuth: () => auth.resolve(alias, new AbortController().signal),
      },
    },
    getModels: () => family.getModels().map((model) => ({
      ...model,
      provider: alias,
      name: `${model.name} (${alias})`,
    })),
    filterModels: family.filterModels?.bind(family),
    stream: (model, context, options) => family.stream(model as never, context, options),
    streamSimple: (model, context, options) => family.streamSimple(model, context, options),
  };
}
