import type { LifeDue, LifeCoverage, LifePolicy } from "kenan-memory/life-contract";

export type NeedsYouItem = {
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
