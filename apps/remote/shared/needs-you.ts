import type { LifeDue, LifeCoverage, LifePolicy, LifeError } from "kenan-memory/life-contract";

export type NeedsYouDismissal =
  | { kind: "life" | "commitment"; id: string; revision: number }
  | { kind: "question"; threadId: string; questionId: string };
export type NeedsYouDismissResult = { ok: true } | { ok: false; error: LifeError | "invalid-state" | "question-failed"; message: string; questionDismissed?: true };

export type NeedsYouItem = {
  dismissal: NeedsYouDismissal;
  id: string;
  kind: "question" | "decision" | "missing-fact" | "person-only-action" | "commitment";
  title: string;
  consequence: string | null;
  deadline: LifeDue;
  recommendation: string | null;
  nextAction: string | null;
  commitmentId: string | null;
  location: { threadId: string; questionId: string | null } | null;
};
export type NeedsYouSource<T> = { state: "ready"; value: T } | { state: "failed"; error: string };
export type NeedsYouProjection = {
  readAt: string;
  items: NeedsYouItem[];
  life: NeedsYouSource<{ coverage: LifeCoverage[] }>;
  policy: NeedsYouSource<LifePolicy | null>;
  questions: { state: "complete" } | { state: "partial"; errors: string[] };
  watch: NeedsYouSource<{ count: number; nextDueAt: number | null; lastActualCheck: null }>;
};
