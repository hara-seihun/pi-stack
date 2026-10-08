import { expect, test } from "bun:test";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AttentionScreen } from "./src/attention";
import { NeedsYouCard } from "./src/needs-you";
import { QuestionText } from "./src/features/conversation/question-content";
import type { NeedsYouItem } from "../shared/needs-you";

const item: NeedsYouItem = {
  id: "question:thread:q", kind: "question", title: "Which appointment works?", consequence: null,
  deadline: null, recommendation: null, nextAction: null, commitmentId: null,
  location: { threadId: "thread", questionId: "q" },
  dismissal: { kind: "question", threadId: "thread", questionId: "q" },
};

test("Attention puts the feed before calendar controls and keeps utilities collapsed", () => {
  const html = renderToStaticMarkup(<AttentionScreen version={0} />);
  const feedStart = html.indexOf('<section aria-label="Now">');
  expect(feedStart).toBeGreaterThan(0);
  expect(html.slice(0, feedStart)).not.toMatch(/<button|<input|<select|<header/);
  expect(html.indexOf('class="attention-calendar-settings"')).toBeGreaterThan(feedStart);
  expect(html).not.toContain('<details class="attention-calendar-settings" open');
});

function questionSources(node: ReactNode): string[] {
  return Children.toArray(node).flatMap(child => {
    if (isValidElement<{ source: string }>(child) && child.type === QuestionText) return [child.props.source];
    if (isValidElement<{ children?: ReactNode }>(child)) return questionSources(child.props.children);
    return [];
  });
}

test("need cards omit empty metadata but keep supplied context and the original answer target", () => {
  const simpleCard = NeedsYouCard({ item, busy: false, onDismiss() {} });
  expect(questionSources(simpleCard)).toEqual([item.title]);
  const simple = renderToStaticMarkup(simpleCard);
  expect(simple).not.toContain("Unknown");
  expect(simple).not.toContain("<dl>");
  expect(simple).not.toContain("<details");
  expect(simple).toContain("question=q");
  const detailedItem = { ...item, nextAction: "Pick **a morning**", consequence: "The booking is held until Friday", recommendation: "Tuesday works `best`" };
  const detailedCard = NeedsYouCard({ item: detailedItem, busy: false, onDismiss() {} });
  // Markdown populates the browser DOM in a layout effect, not during static rendering.
  expect(questionSources(detailedCard)).toEqual([item.title, detailedItem.nextAction, detailedItem.recommendation]);
  const detailed = renderToStaticMarkup(detailedCard);
  expect(detailed).toContain("The booking is held until Friday");
  expect(detailed).toContain("question=q");
  expect(detailed).toContain('<details class="attention-card-details">');
});
