import type { ThreadQuestion } from "../../../../server/protocol";
import { Markdown } from "../../context";
import "./question-content.css";

export function QuestionText({ source, className = "" }: { source: string; className?: string }) {
  return <Markdown source={source} sessionId="" sessionMedia={false} className={`markdown-body question-markdown ${className}`} />;
}

export function QuestionContent({ question, selected, disabled, onToggle }: {
  question: Pick<ThreadQuestion, "question" | "suggestions" | "recommendedSuggestionId">;
  selected: string[];
  disabled: boolean;
  onToggle(id: string): void;
}) {
  return <>
    <QuestionText source={question.question} className="question-prompt" />
    {question.suggestions.length > 0 && <fieldset className="question-options" disabled={disabled}>
      <legend>Choose any</legend>
      {question.suggestions.map(suggestion => <label key={suggestion.id} className="question-option">
        <input type="checkbox" checked={selected.includes(suggestion.id)} onChange={() => onToggle(suggestion.id)} />
        <div className="question-option-content">
          <QuestionText source={suggestion.text} />
          {question.recommendedSuggestionId === suggestion.id && <span className="question-recommended">Recommended</span>}
        </div>
      </label>)}
    </fieldset>}
  </>;
}
