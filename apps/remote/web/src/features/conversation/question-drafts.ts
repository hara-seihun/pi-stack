import { appStorageKey } from "../../app-path";
import type { ThreadQuestion } from "../../../../server/protocol";

export function prioritizeQuestion(questions: ThreadQuestion[], id: string | undefined): ThreadQuestion[] {
  if (id === undefined) return questions;
  const selected = questions.find(question => question.id === id);
  return selected ? [selected, ...questions.filter(question => question.id !== id)] : questions;
}

export interface QuestionDraft { selectedSuggestionIds: string[]; text: string }
export const emptyQuestionDraft = (): QuestionDraft => ({ selectedSuggestionIds: [], text: "" });
export function answerIsValid(draft: QuestionDraft) { return draft.selectedSuggestionIds.length > 0 || draft.text.trim().length > 0; }
export function toggleSuggestion(draft: QuestionDraft, id: string): QuestionDraft {
  return { ...draft, selectedSuggestionIds: draft.selectedSuggestionIds.includes(id) ? draft.selectedSuggestionIds.filter(value => value !== id) : [...draft.selectedSuggestionIds, id] };
}

export function questionDraftKey(person: string, sessionId: string, questionId: string) {
  return appStorageKey(`pi-remote-question:${person}:${sessionId}:${questionId}`);
}
export class QuestionDrafts {
  constructor(private storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, private person: string) {}
  private key(sessionId: string, questionId: string) { return questionDraftKey(this.person, sessionId, questionId); }
  load(sessionId: string, questionId: string): QuestionDraft {
    try {
      const raw = this.storage.getItem(this.key(sessionId, questionId));
      if (raw) {
        const value: unknown = JSON.parse(raw);
        if (value && typeof value === "object" && "text" in value && "selectedSuggestionIds" in value && typeof value.text === "string" && Array.isArray(value.selectedSuggestionIds) && value.selectedSuggestionIds.every(id => typeof id === "string")) return value as QuestionDraft;
      }
    } catch { /* Storage may be unavailable. The current dialog still keeps the draft. */ }
    return emptyQuestionDraft();
  }
  save(sessionId: string, questionId: string, draft: QuestionDraft) {
    try { this.storage.setItem(this.key(sessionId, questionId), JSON.stringify(draft)); } catch { /* Storage may be unavailable. */ }
  }
  clear(sessionId: string, questionId: string) {
    try { this.storage.removeItem(this.key(sessionId, questionId)); } catch { /* Storage may be unavailable. */ }
  }
}
