import type { CoreSessionOptions } from "./contracts.js";
import type { CoreAccountCredentialRequest, CoreAccountCredentials, CoreAccountUsage } from "./account.js";

export type CodexCredentials = CoreAccountCredentials;
export type CodexUsage = CoreAccountUsage;
export interface CodexAccountLease {
  credentials(request?: CoreAccountCredentialRequest): Promise<CodexCredentials>;
  /** Cumulative per-thread counters. The broker must upsert, not sum notifications. */
  recordUsage(usage: CodexUsage): void | Promise<void>;
  setActive(active: boolean): void;
  close(): void | Promise<void>;
}
export type OpenCodexAccount = (options: CoreSessionOptions) => Promise<CodexAccountLease>;

export function credentialGuard() {
  const secrets = new Set<string>();
  return {
    remember(credentials: CodexCredentials) {
      secrets.add(credentials.accessToken);
      if (credentials.chatgptAccountId) secrets.add(credentials.chatgptAccountId);
    },
    clean<T>(value: T): T {
      const visit = (input: unknown): unknown => {
        if (typeof input === "string") {
          for (const secret of secrets) if (secret) input = (input as string).split(secret).join("[redacted]");
          return (input as string).replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");
        }
        if (Array.isArray(input)) return input.map(visit);
        if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([key, entry]) => [key,
          /^(access_?token|refresh_?token|id_?token|api_?key|authorization|chatgptAccountId)$/i.test(key) ? "[redacted]" : visit(entry)]));
        return input;
      };
      return visit(value) as T;
    },
  };
}
