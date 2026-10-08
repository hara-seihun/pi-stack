import { expect, test } from "bun:test";
import { QuestionContent, QuestionText } from "./src/features/conversation/question-content";
import { NotificationCard } from "./src/features/notifications/NotificationCard";

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

test("question history renders Markdown outside its original-conversation link", () => {
  const card = NotificationCard({ item: { seq: 1, sessionId: "thread", name: "Appointment", time: "2026-10-08T20:00:00Z", kind: "question", body: question.question, questionId: "q1", status: "history" } });
  const row = card.props.children;
  expect(row.type).toBe("div");
  const children = row.props.children.props.children;
  expect(children[1].type).toBe(QuestionText);
  expect(children[1].props.source).toBe(question.question);
  expect(children[3].type).toBe("a");
  expect(children[3].props.href).toContain("question=q1");
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
