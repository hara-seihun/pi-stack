import type { LifeResult, LifeSnapshot, LifePolicyView } from "kenan-memory/life-contract";
import type { ThreadApi, QuestionThread, ThreadQuestion, WatchItem, WatchResponse, Result } from "pi-orchestrator/api";
import type { NeedsYouItem, NeedsYouProjection } from "../shared/needs-you";
import { commitmentReminderDismissed } from "./needs-you-dismissal";

export type NeedsYouQuestions = { questions: ThreadQuestion[]; threadIds: Set<string>; errors: string[] };

export async function readNeedsYouQuestions(owners: readonly { id: string; api: Pick<ThreadApi, "pendingQuestions"> }[], include: (thread: QuestionThread) => boolean, locationThreadIds: string[]): Promise<NeedsYouQuestions> {
  const questions: ThreadQuestion[] = [];
  const threadIds = new Set<string>();
  const errors: string[] = [];
  await Promise.all(owners.map(async owner => {
    try {
      const result = await owner.api.pendingQuestions({ locationThreadIds });
      if (!result.ok) { errors.push(`${owner.id}: ${result.error.message}`); return; }
      const visible = new Map(result.value.threads.filter(include).map(thread => [thread.id, thread]));
      for (const id of visible.keys()) threadIds.add(id);
      questions.push(...result.value.questions.filter(question => visible.has(question.threadId)));
      for (const failure of result.value.errors) {
        const thread = visible.get(failure.threadId);
        if (thread) errors.push(`${thread.title ?? thread.id}: ${failure.message}`);
        else if (!result.value.threads.some(thread => thread.id === failure.threadId)) errors.push(`${owner.id}: ${failure.message}`);
      }
    } catch (cause) { errors.push(`${owner.id}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }));
  return { questions, threadIds, errors };
}

function lifeItems(snapshot: LifeSnapshot, pending: NeedsYouQuestions): NeedsYouItem[] {
  const current = snapshot.entities.filter(entity => entity.status === "current");
  const decisions = current.filter(entity => entity.value.kind === "needs-you" && entity.value.state === "open");
  const linkedCommitments = new Set(decisions.flatMap(entity => entity.value.kind === "needs-you" && entity.value.commitmentId !== null ? [entity.value.commitmentId] : []));
  const activeQuestions = new Map(pending.questions.map(question => [question.id, question]));
  const items: NeedsYouItem[] = [];
  for (const entity of current) {
    const value = entity.value;
    const thread = entity.threadId !== null && pending.threadIds.has(entity.threadId) ? { threadId: entity.threadId, questionId: null } : null;
    if (value.kind === "needs-you" && value.state === "open") {
      if (value.questionId !== null && !activeQuestions.has(value.questionId) && pending.errors.length === 0) continue;
      const question = value.questionId === null ? undefined : activeQuestions.get(value.questionId);
      items.push({ id: `life:${entity.id}`, dismissal: { kind: "life", id: entity.id, revision: entity.revision }, kind: question ? "question" : value.reason, title: value.title,
        consequence: value.consequence, deadline: value.requiredBy, recommendation: value.recommendation,
        nextAction: null, commitmentId: value.commitmentId,
        location: question ? { threadId: question.threadId, questionId: question.id } : thread });
    } else if (value.kind === "commitment" && value.state === "waiting" && value.waiting?.for === "person" && value.owner.kind === "person" && value.owner.person === snapshot.subject && !linkedCommitments.has(entity.id) && !commitmentReminderDismissed(entity, current)) {
      items.push({ id: `life:${entity.id}`, dismissal: { kind: "commitment", id: entity.id, revision: entity.revision }, kind: "commitment", title: value.title, consequence: null,
        deadline: value.due, recommendation: null, nextAction: value.nextAction, commitmentId: entity.id, location: thread });
    }
  }
  const linkedQuestions = new Set(decisions.flatMap(entity => entity.value.kind === "needs-you" && entity.value.questionId !== null ? [entity.value.questionId] : []));
  return [...items, ...questionItems(pending.questions.filter(question => !linkedQuestions.has(question.id)))];
}

function questionItems(questions: ThreadQuestion[]): NeedsYouItem[] {
  return questions.map(question => ({ id: `question:${question.id}`, dismissal: { kind: "question", threadId: question.threadId, questionId: question.id }, kind: "question", title: question.question,
    consequence: null, deadline: null,
    recommendation: question.recommendedSuggestionId === undefined ? null : question.suggestions.find(suggestion => suggestion.id === question.recommendedSuggestionId)?.text ?? null,
    nextAction: null, commitmentId: null, location: { threadId: question.threadId, questionId: question.id } }));
}

export function projectNeedsYou(life: LifeResult<LifeSnapshot>, pending: NeedsYouQuestions, watch: Result<WatchResponse>, policy: LifeResult<LifePolicyView>, now: number): NeedsYouProjection {
  const items = life.ok ? lifeItems(life.value, pending) : questionItems(pending.questions);
  items.sort((a, b) => {
    if (a.deadline === null && b.deadline === null) return a.id.localeCompare(b.id);
    if (a.deadline === null) return 1;
    if (b.deadline === null) return -1;
    return Date.parse(a.deadline.at) - Date.parse(b.deadline.at) || a.id.localeCompare(b.id);
  });
  const watchItems: WatchItem[] | null = watch.ok && "items" in watch.value ? watch.value.items : null;
  return {
    readAt: new Date(now).toISOString(), items,
    life: life.ok ? { state: "ready", value: { coverage: life.value.coverage } } : { state: "failed", error: life.message },
    policy: policy.ok ? { state: "ready", value: policy.value.current } : { state: "failed", error: policy.message },
    questions: pending.errors.length === 0 ? { state: "complete" } : { state: "partial", errors: pending.errors },
    watch: watchItems !== null ? { state: "ready", value: { count: watchItems.length, nextDueAt: watchItems.length ? Math.min(...watchItems.map(item => item.nextDueAt)) : null, lastActualCheck: null } }
      : { state: "failed", error: watch.ok ? "Watch owner returned an invalid list response" : watch.error.message },
  };
}
