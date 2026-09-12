import type { CoreSessionOptions } from "./contracts.js";

/** This interface belongs at the broker boundary, never on the runtime event wire. */
export interface CodexCredentials {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType?: string | null;
}
export interface CodexUsage {
  sessionId: string;
  nativeThreadId: string;
  turnId: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}
export interface CodexAccountLease {
  credentials(request?: { refresh: boolean; previousAccountId?: string }): Promise<CodexCredentials>;
  /** Cumulative per-thread counters. The broker must upsert, not sum notifications. */
  recordUsage(usage: CodexUsage): void | Promise<void>;
  close(): void | Promise<void>;
}
export type OpenCodexAccount = (options: CoreSessionOptions) => Promise<CodexAccountLease>;

export function credentialGuard() {
  const secrets = new Set<string>();
  return {
    remember(credentials: CodexCredentials) {
      secrets.add(credentials.accessToken);
      secrets.add(credentials.chatgptAccountId);
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
