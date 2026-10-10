import { expect, test } from "bun:test";
import { QuestionContent, QuestionText } from "./src/features/conversation/question-content";

const question = {
  question: "**Which release?**\n\n- Keep `v1` until Friday.\n- Ship [v2](https://example.test/release) now.",
  suggestions: [{ id: "keep", text: "**Keep v1**\nNo downtime." }, { id: "ship", text: "Ship `v2`" }],
  recommendedSuggestionId: "keep",
};

test("question and option Markdown preserve authored content and cannot resolve session media", () => {
  const content = QuestionContent({ question, selected: [], disabled: false, onToggle() {} });
  const prompt = content.props.children[0];
  expect(prompt.type).toBe(QuestionText);
  expect(prompt.props.source).toBe(question.question);
  const options = content.props.children[1].props.children[1];
  for (const [index, option] of options.entries()) {
    const text = option.props.children[1].props.children[0];
    expect(text.props.source).toBe(question.suggestions[index]!.text);
    const markdown = QuestionText(text.props);
    expect(markdown.props.sessionMedia).toBe(false);
    expect(markdown.props.sessionId).toBe("");
  }
  expect(QuestionText(prompt.props).props.sessionMedia).toBe(false);
});

test("recommendations stay unselected, multiselect controls retain canonical IDs, and pending answers lock options", () => {
  const toggled: string[] = [];
  const content = QuestionContent({ question, selected: ["ship"], disabled: true, onToggle: id => toggled.push(id) });
  const fieldset = content.props.children[1];
  expect(fieldset.props.disabled).toBe(true);
  const options = fieldset.props.children[1];
  expect(options[0].props.children[0].props.checked).toBe(false);
  expect(options[1].props.children[0].props.checked).toBe(true);
  options[0].props.children[0].props.onChange();
  expect(toggled).toEqual(["keep"]);
  expect(options[0].props.children[1].props.children[1]).toBeTruthy();
  expect(options[1].props.children[1].props.children[1]).toBe(false);
});
