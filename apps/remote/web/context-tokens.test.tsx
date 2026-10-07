import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "../server/protocol";
import { ContextTokens, ConversationModelMeta, formatContextUsage } from "./src/features/conversation/ContextTokens";

type ContextUsage = NonNullable<Session["contextUsage"]>;
const usage = (fields: Partial<ContextUsage> = {}): ContextUsage => ({
  tokens: 12_345, contextWindow: 200_000, percent: 6.1725, ...fields,
});

for (const [tokens, label] of [
  [0, "~0 tok"], [999, "~999 tok"], [12_345, "~12.3K tok"], [128_000, "~128K tok"], [1_234_567, "~1.2M tok"],
] as const) {
  test(`formats ${tokens} current-context tokens compactly without abbreviating accessible counts`, () => {
    const formatted = formatContextUsage(usage({ tokens }));
    expect(formatted.label).toBe(label);
    expect(formatted.detail).toContain(`${tokens.toLocaleString("en")} tokens`);
    expect(formatted.detail).toContain("Estimated current context");
  });
}

test("the abbreviated count is hidden from assistive readers, which get the estimate, exact count, window and percentage", () => {
  const html = renderToStaticMarkup(<ContextTokens usage={usage()} />);
  const detail = "Estimated current context: 12,345 tokens; 200,000 token context window; 6.2% used";
  expect(html).toContain(`title="${detail}"`);
  expect(html).toContain('<span aria-hidden="true">~12.3K tok</span>');
  expect(html).toContain(`<span class="context-tokens-detail">${detail}</span>`);
});

test("missing usage is unavailable, never a zero count or a percentage", () => {
  const formatted = formatContextUsage(undefined);
  expect(formatted.label).toBe("Context —");
  expect(formatted.detail).toContain("unavailable");
  expect(formatted.detail).not.toContain("0");
  const html = renderToStaticMarkup(<ContextTokens usage={undefined} />);
  expect(html).toContain('title="Context token usage unavailable"');
  expect(html).not.toContain("~0 tok");
});

test("after compaction null tokens explicitly recalculate until the next response, without a stale percent", () => {
  const formatted = formatContextUsage(usage({ tokens: null, percent: null }));
  expect(formatted.label).toBe("Context …");
  expect(formatted.detail).toContain("recalculating after compaction");
  expect(formatted.detail).toContain("next model response");
  expect(formatted.detail).toContain("200,000 token context window");
  expect(formatted.detail).not.toContain("% used");
  expect(formatted.detail).not.toContain("0 tokens");
  expect(formatContextUsage(usage({ tokens: null, percent: 90 }))).toEqual(formatted);
});

test("unknown window and percent stay unavailable rather than dividing by zero", () => {
  const formatted = formatContextUsage(usage({ contextWindow: 0, percent: null }));
  expect(formatted.label).toBe("~12.3K tok");
  expect(formatted.detail).toContain("context window unavailable");
  expect(formatted.detail).not.toContain("% used");
});

test("model metadata gives the model its own truncatable element, separate from the count", () => {
  const html = renderToStaticMarkup(<ConversationModelMeta session={{ model: "provider/a-long-model-name", contextUsage: usage() }} />);
  expect(html).toContain('class="conversation-meta conversation-agent-model" title="provider/a-long-model-name">a-long-model-name</span>');
  expect(html).toContain('class="context-tokens"');
  expect(html).toContain("~12.3K tok");
});
