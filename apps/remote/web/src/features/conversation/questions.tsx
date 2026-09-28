import { useState } from "react";
import type { ThreadQuestion } from "../../../../server/protocol";
import { API } from "../../../../server/api";
import { Sheet } from "../../app/Sheet";
import { api } from "../../client";
import { answerIsValid, QuestionDrafts, toggleSuggestion, type QuestionDraft } from "./question-drafts";
import "./questions.css";

function QuestionForm({ sessionId, question, drafts, onAccepted }: { sessionId: string; question: ThreadQuestion; drafts: QuestionDrafts; onAccepted(id: string): void }) {
  const [draft, setDraft] = useState(() => drafts.load(sessionId, question.id));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const change = (next: QuestionDraft) => { setDraft(next); drafts.save(sessionId, question.id, next); };
  const submit = async () => {
    if (!answerIsValid(draft) || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await api(API.sessionQuestionAnswer.method, API.sessionQuestionAnswer.path({ sessionId, questionId: question.id }), draft);
      drafts.clear(sessionId, question.id);
      onAccepted(question.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSubmitting(false); }
  };
  return <form className="question-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <h3>{question.question}</h3>
    {question.suggestions.length > 0 && <fieldset disabled={submitting}><legend>Suggested answers (choose any)</legend>
      {question.suggestions.map(suggestion => <label key={suggestion.id} className="question-option">
        <input type="checkbox" checked={draft.selectedSuggestionIds.includes(suggestion.id)} onChange={() => change(toggleSuggestion(draft, suggestion.id))} />
        <span>{suggestion.text}{question.recommendedSuggestionId === suggestion.id && <span className="question-recommended">Recommended</span>}</span>
      </label>)}
    </fieldset>}
    <label className="question-text-label">Your answer or additional context
      <textarea value={draft.text} disabled={submitting} onChange={event => change({ ...draft, text: event.target.value })} rows={3} placeholder="Write your own answer, with or without suggestions" />
    </label>
    {error && <p role="alert" className="question-error">{error}</p>}
    <button type="submit" className="question-submit" disabled={submitting || !answerIsValid(draft)}>{submitting ? "Sending…" : "Submit answer"}</button>
  </form>;
}

export function QuestionsSheet({ sessionId, questions, open, onClose, onAccepted }: {
  sessionId: string;
  questions: ThreadQuestion[];
  open: boolean;
  onClose(): void;
  onAccepted(id: string): void;
}) {
  const drafts = new QuestionDrafts(localStorage, window.PiRemotePerson.get());
  return <Sheet open={open} title={`Questions to answer (${questions.length})`} onClose={onClose}>
    {questions.length === 0 ? <p className="questions-empty">No questions to answer.</p> : questions.map(question => <QuestionForm key={question.id} sessionId={sessionId} question={question} drafts={drafts} onAccepted={onAccepted} />)}
  </Sheet>;
}
