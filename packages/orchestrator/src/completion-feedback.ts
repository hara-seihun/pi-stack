import type { Store } from "./store.js";

interface Feedback { limit: number; blockedUntil: number; rejections: number; successes: number }
const key = (accountId: string) => `completion-feedback:${accountId}`;
function read(store: Store, accountId: string): Feedback | undefined {
  const raw = store.control(key(accountId)); return raw ? JSON.parse(raw) : undefined;
}
export function activeCompletions(store: Store, accountId: string): number {
  return Number((store.db.prepare(`SELECT count(*) n FROM lease l WHERE account_id=? AND ended_at IS NULL
    AND EXISTS (SELECT 1 FROM control c WHERE c.key='completion-run:'||l.run_id)`).get(accountId) as { n: number }).n);
}
export function completionFeedbackRefusal(store: Store, accountId: string, now: number): string | undefined {
  const feedback = read(store, accountId);
  if (!feedback) return;
  if (feedback.blockedUntil > now) return `provider rejection backoff until ${feedback.blockedUntil}`;
  const active = activeCompletions(store, accountId);
  if (active >= feedback.limit) return `provider feedback window ${active}/${feedback.limit}`;
}
export function recordCompletionRejection(store: Store, accountId: string, now: number, retryAfterMs?: number, observed = activeCompletions(store, accountId)): number {
  const previous = read(store, accountId), sameWave = !!previous && previous.blockedUntil > now;
  const rejections = sameWave ? previous.rejections : (previous?.rejections ?? 0) + 1;
  const limit = sameWave ? previous.limit : Math.max(1, Math.floor(Math.min(previous?.limit ?? observed, observed) / 2));
  const delay = Math.max(1000, retryAfterMs ?? Math.min(60_000, 1000 * 2 ** Math.min(rejections - 1, 6)));
  const blockedUntil = Math.max(previous?.blockedUntil ?? 0, now + delay);
  store.setControl(key(accountId), JSON.stringify({ limit, blockedUntil, rejections, successes: 0 } satisfies Feedback));
  store.setCooldown(accountId, Math.max(store.account(accountId)?.cooldownUntil ?? 0, blockedUntil));
  return blockedUntil;
}
export function recordCompletionSuccess(store: Store, accountId: string, now: number): void {
  const feedback = read(store, accountId);
  if (!feedback || now < feedback.blockedUntil) return;
  feedback.successes++;
  if (feedback.successes >= feedback.limit) { feedback.limit *= 2; feedback.successes = 0; feedback.rejections = 0; }
  store.setControl(key(accountId), JSON.stringify(feedback));
}
