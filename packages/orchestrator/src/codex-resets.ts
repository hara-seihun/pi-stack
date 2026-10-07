import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";

export interface ResetAttempt {
  readonly creditId: string;
  readonly requestId: string;
  readonly at: number;
  readonly beforeResetAt?: number;
  readonly status: "pending" | "accepted" | "confirmed" | "failed";
  readonly detail?: string;
}
const key = (accountId: string) => `codex-reset-attempt:${accountId}`;
export function codexResetAttempt(store: Store, accountId: string): ResetAttempt | undefined {
  const value = store.control(key(accountId));
  return value ? JSON.parse(value) as ResetAttempt : undefined;
}

/** Persist before POST: an interrupted or ambiguous redemption never spends a second credit. */
export function claimCodexReset(store: Store, accountId: string, creditId: string, resetAt?: number): ResetAttempt | undefined {
  return store.transaction(() => {
    const previous = codexResetAttempt(store, accountId);
    if (previous && (previous.status !== "confirmed" || previous.creditId === creditId || resetAt === undefined || previous.beforeResetAt === resetAt)) return undefined;
    const attempt: ResetAttempt = { creditId, requestId: randomUUID(), at: Date.now(), beforeResetAt: resetAt, status: "pending" };
    store.setControl(key(accountId), JSON.stringify(attempt));
    return attempt;
  });
}
export function recordCodexResetResult(store: Store, accountId: string, attempt: ResetAttempt, accepted: boolean, detail: string): void {
  store.transaction(() => {
    const current = codexResetAttempt(store, accountId);
    if (current?.requestId !== attempt.requestId || current.status === "confirmed") return;
    store.setControl(key(accountId), JSON.stringify({ ...current, status: accepted ? "accepted" : "failed", detail }));
  });
}

/** A fresh provider drop is the evidence that releases capacity, not a POST acknowledgement. */
export function confirmCodexReset(store: Store, accountId: string, usedPercent: number, observedAt: number): void {
  if (usedPercent >= 100) return;
  store.transaction(() => {
    const current = codexResetAttempt(store, accountId);
    if (!current || current.status === "confirmed" || observedAt <= current.at) return;
    store.setControl(key(accountId), JSON.stringify({ ...current, status: "confirmed" }));
    store.setCooldown(accountId);
  });
}
