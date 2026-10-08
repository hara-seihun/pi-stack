import { useState } from "react";
import type { ThreadQuestion } from "../../../../server/protocol";
import { API } from "../../../../server/api";
import { Composer } from "../../Composer";
import { api } from "../../client";
import { answerIsValid, QuestionDrafts, toggleSuggestion, type QuestionDraft } from "./question-drafts";
import { QuestionContent } from "./question-content";
import "./questions.css";

function QuestionForm({ sessionId, question, drafts, onAccepted }: { sessionId: string; question: ThreadQuestion; drafts: QuestionDrafts; onAccepted(id: string): void }) {
  const [draft, setDraft] = useState(() => drafts.load(sessionId, question.id));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const change = (next: QuestionDraft) => { setDraft(next); drafts.save(sessionId, question.id, next); };
  const submit = async (dismissed = false) => {
    if ((!dismissed && !answerIsValid(draft)) || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await api(API.sessionQuestionAnswer.method, API.sessionQuestionAnswer.path({ sessionId, questionId: question.id }), dismissed ? { selectedSuggestionIds: [], text: "", dismissed: true } : draft);
      drafts.clear(sessionId, question.id);
      onAccepted(question.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSubmitting(false); }
  };
  return <div className="question-form">
    <Composer id="question-answer" value={draft.text} onChange={text => change({ ...draft, text })} onSend={() => void submit()}
      placeholder="Your answer or additional context" sendLabel="Submit answer" layoutKey={question.id}
      disabled={submitting || !answerIsValid(draft)} readOnly={submitting} hideAttachments
      attachments={[]} onRemove={() => {}} onUpload={() => {}} onPaste={() => {}} onDraw={() => {}}
      before={<><QuestionContent question={question} selected={draft.selectedSuggestionIds} disabled={submitting}
        onToggle={id => change(toggleSuggestion(draft, id))} />
        {error && <p role="alert" className="question-error">{error}</p>}</>}
      actions={<button type="button" className="question-dismiss" disabled={submitting} onClick={() => void submit(true)}>{submitting ? "Sending…" : "Dismiss question"}</button>} />
  </div>;
}

export function QuestionsComposer({ sessionId, questions, onAccepted }: {
  sessionId: string;
  questions: ThreadQuestion[];
  onAccepted(id: string): void;
}) {
  const drafts = new QuestionDrafts(localStorage, window.PiRemotePerson.get());
  const question = questions[0];
  if (!question) return null;
  return <section className="questions-composer" aria-label="Questions to answer">
    <div className="questions-heading" role="status">{questions.length === 1 ? "Your answer" : `${questions.length} questions`}</div>
    <QuestionForm key={`${sessionId}:${question.id}`} sessionId={sessionId} question={question} drafts={drafts} onAccepted={onAccepted} />
  </section>;
}
