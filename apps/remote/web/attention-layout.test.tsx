import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AttentionScreen } from "./src/attention";
import { NeedsYouCard } from "./src/needs-you";
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

test("need cards omit empty metadata but keep supplied context and the original answer target", () => {
  const simple = renderToStaticMarkup(<NeedsYouCard item={item} busy={false} onDismiss={() => {}} />);
  expect(simple).not.toContain("Unknown");
  expect(simple).not.toContain("<dl>");
  expect(simple).not.toContain("<details");
  expect(simple).toContain("question=q");
  const detailed = renderToStaticMarkup(<NeedsYouCard item={{ ...item, nextAction: "Pick a morning", consequence: "The booking is held until Friday", recommendation: "Tuesday works best" }} busy={false} onDismiss={() => {}} />);
  expect(detailed).toContain("Pick a morning");
  expect(detailed).toContain("The booking is held until Friday");
  expect(detailed).toContain("Tuesday works best");
  expect(detailed).toContain('<details class="attention-card-details">');
});
