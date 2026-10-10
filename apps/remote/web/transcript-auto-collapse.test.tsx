import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptItemBody } from "../server/protocol";
import type { BodyCache } from "./src/client-cache";
import { ItemBodies, ItemBodiesContext } from "./src/features/conversation/item-bodies";
import { Transcript, type TranscriptProps } from "./src/features/conversation/Transcript";
import type { ContextEntry } from "./src/types";

globalThis.location ??= new URL("https://router.test/") as unknown as Location;

const entry = (key: string, kind: ContextEntry["kind"], fields: Partial<ContextEntry> = {}): ContextEntry => ({
  key, kind, signature: key, text: key, ...fields,
});
const thought = entry("first thought detail", "thinking", { label: "First thought" });
const read = entry("read", "toolCall", {
  text: undefined,
  toolCall: { name: "read", arguments: { path: "/work/first.ts" } },
  toolResult: { preview: "first tool result", size: 17, isError: false },
});
const bash = entry("bash", "toolCall", {
  text: undefined,
  toolCall: { name: "bash", arguments: { command: "printf second" } },
  toolResult: { preview: "second tool result", size: 18, isError: false },
});
const work = [thought, read, entry("schema detail", "tool"), entry("notice detail", "notice"), entry("second thought detail", "thinking", { label: "Second thought" }), bash];
const user = entry("user message", "user");
const answer = entry("final answer", "assistant");
const props: TranscriptProps = {
  entries: [user, ...work, answer], sessionId: "thread", home: "/work", images: null,
  onEdit() {}, onReply() {},
};

function render(patch: Partial<TranscriptProps> = {}, bodies: ItemBodies | null = null) {
  return renderToStaticMarkup(<ItemBodiesContext.Provider value={bodies}><Transcript {...props} {...patch} /></ItemBodiesContext.Provider>);
}

function steps(html: string) {
  return html.match(/<details\b[^>]*>[\s\S]*?<\/details>/g) ?? [];
}

function expectExpanded(html: string, count: number) {
  expect(html).not.toContain("work-card");
  expect(html).not.toContain("work-latest");
  const details = steps(html);
  expect(details).toHaveLength(count);
  for (const detail of details) expect(detail.match(/^<details\b[^>]*>/)?.[0]).toMatch(/\bopen=""/);
  return details;
}

function expectOrder(html: string, fragments: string[]) {
  let previous = -1;
  for (const fragment of fragments) {
    const position = html.indexOf(fragment);
    expect(position).toBeGreaterThan(previous);
    previous = position;
  }
}

test("empty and streamed-to-empty assistants leave no rendered row, avatar or spacing", () => {
  const blank = entry("streamed-answer", "assistant", { text: " \n", streaming: true });
  for (const mono of [true, false]) for (const autoCollapse of [true, false]) {
    const options = { mono, autoCollapse };
    const baseline = render({ ...options, entries: [user] });
    expect(render({ ...options, entries: [user, blank] })).toBe(baseline);
    const visible = render({ ...options, entries: [user, { ...blank, text: "Authored reply", signature: "nonempty" }] });
    expect(visible).toContain('class="message assistant');
    expect(render({ ...options, entries: [user, { ...blank, text: "", signature: "empty" }] })).toBe(baseline);
    expect(render({ ...options, entries: [user, ...work, blank] })).toBe(render({ ...options, entries: [user, ...work] }));
  }
});

test("omitting autoCollapse preserves the compact WorkCard, as does explicit true", () => {
  const html = render();
  expect(render({ autoCollapse: true })).toBe(html);
  expect(html).toContain('class="work-card"');
  expect(html).toContain('class="work-card-header" aria-expanded="false"');
  expect(html).toContain('class="work-latest"');
  expect(steps(html)).toHaveLength(1);
  expect(steps(html)[0]?.match(/^<details\b[^>]*>/)?.[0]).not.toContain('open=""');
  expect(html).toContain("second tool result");
  expect(html).not.toContain("First thought");
  expect(html).not.toContain("first tool result");
});

test("mono keeps assistant text plain after tools and before an unsettled wait, independently of live thinking", () => {
  const final = { ...answer, seq: 20, streaming: true };
  const wait = entry("unsettled wait", "toolCall", { seq: 21, text: undefined,
    toolCall: { name: "thread_wait", arguments: { action: "set", kind: "agents", threadIds: ["worker"] } } });
  const entries = [user, ...work, final, wait];
  const before = JSON.stringify(entries);
  for (const autoCollapse of [true, false]) {
    for (const tail of [[], [wait]]) {
      const html = render({ mono: true, autoCollapse, entries: [user, ...work, final, ...tail], thinkingActive: true, liveThinking: "Live private reasoning" });
      expect(html.match(/class="message assistant/g)).toHaveLength(1);
      expect(html).toContain('<div data-transcript-seq="20"><article');
      expect(html.match(/class="work-card(?: running)?"/g)).toHaveLength(1);
      expect(html).toContain('class="work-card-header" aria-expanded="false"');
      expect(html).not.toContain("work-latest");
      expect(html).not.toContain("conversation-step");
      expect(html).not.toContain("step-arguments");
      expect(html).not.toContain("step-thinking-body");
      expect(html).not.toContain("Live private reasoning");
      expect(html).not.toContain('data-transcript-seq="21"');
    }
  }
  const classic = render({ entries });
  expect(classic.match(/class="message assistant/g)).toHaveLength(1);
  expect(classic).toContain('<div data-transcript-seq="20"><article');
  expect(classic).toContain("work-card");
  expect(JSON.stringify(entries)).toBe(before);
});

test("mono retains hidden wake activity in collapsed work rather than visible narration", () => {
  const html = render({ mono: true, entries: [user, entry("wake input", "user", { monoVisibility: "hidden" }), entry("quiet answer", "assistant", { monoVisibility: "hidden" }), entry("quiet tool", "toolCall", { monoVisibility: "hidden", toolCall: { name: "read", arguments: {} } }), answer] });
  expect(html.match(/class="message user/g)).toHaveLength(1);
  expect(html.match(/class="message assistant/g)).toHaveLength(1);
  expect(html).not.toContain("wake input");
  expect(html).not.toContain("quiet answer");
  expect(html).toContain('class="work-card running"');
  expect(html).toContain("Work · 3 steps");
});

test("autoCollapse false renders every intervening entry individually expanded and in transcript order", () => {
  const html = render({ autoCollapse: false, entries: [entry("system detail", "system"), user, ...work, answer] });
  const details = expectExpanded(html, work.length + 1);
  expect(details[0]).toContain("system detail");
  expect(details[1]).toContain("First thought");
  expect(details[1]).toContain('class="markdown-body step-thinking-body"');
  expect(details[2]).toContain("/work/first.ts");
  expect(details[2]).toContain("first tool result");
  expect(details[3]).toContain("schema detail");
  expect(details[4]).toContain("notice detail");
  expect(details[5]).toContain("Second thought");
  expect(details[5]).toContain('class="markdown-body step-thinking-body"');
  expect(details[6]).toContain("printf second");
  expect(details[6]).toContain("second tool result");
  expectOrder(html, ["system detail", 'class="message user', "First thought", "/work/first.ts", "schema detail", "notice detail", "Second thought", "printf second", 'class="message assistant']);
});

test("autoCollapse false expands live thinking before text arrives and while it streams", () => {
  const waiting = render({ autoCollapse: false, entries: [user], thinkingActive: true, liveThinking: "" });
  const [waitingStep] = expectExpanded(waiting, 1);
  expect(waitingStep).toContain('aria-busy="true"');
  expect(waitingStep).toContain("Waiting for the agent");

  const streaming = render({ autoCollapse: false, entries: [user], thinkingActive: true, liveThinking: "live thought detail" });
  const [streamingStep] = expectExpanded(streaming, 1);
  expect(streamingStep).toContain('aria-busy="true"');
  expect(streamingStep).toContain("<strong>Thinking</strong>");
  expect(streamingStep).toContain('class="markdown-body step-thinking-body"');
  expect(streamingStep).not.toContain("Waiting for the agent");
});

test("tool completion and a final answer both render all thought, argument, and complete result details expanded", () => {
  const fullBody: TranscriptItemBody = {
    kind: "toolCall", arguments: { command: "printf second", description: "complete argument detail" },
    result: { content: [{ type: "text", text: "complete result beyond the head preview" }], isError: false },
  };
  const known = new Map([["complete-bash", fullBody]]);
  const cache: BodyCache = {
    retainBody: () => () => {},
    getBody: id => known.get(id),
    acceptBody: (id, body) => { known.set(id, body); },
    loadBody: (_id, _size, fetcher) => fetcher(),
  };
  const bodies = new ItemBodies("thread", async () => { throw new Error("fixture body must already be cached"); }, cache);
  const running = { ...bash, signature: "bash:running", toolResult: undefined, toolCall: { ...bash.toolCall, partialOutput: "partial tool output" } };
  const completed = { ...bash, signature: "bash:complete", itemId: "complete-bash", argumentsTruncated: true, toolResult: { ...bash.toolResult, preview: "short head preview", size: 900 } };
  const previous = [user, ...work.slice(0, -1)];

  // SSR covers each lifecycle state, not retained React state across a rerender.
  // Markdown writes its text in a layout effect; only its container is observable here.
  const runningHtml = render({ autoCollapse: false, entries: [...previous, running] }, bodies);
  const runningSteps = expectExpanded(runningHtml, work.length);
  expect(runningSteps.at(-1)).toContain('aria-busy="true"');
  expect(runningSteps.at(-1)).toContain("partial tool output");
  expect(runningSteps.at(-1)).toContain('class="step-arguments" tabindex="0" aria-label="Tool arguments"');
  expect(runningSteps.at(-1)).toContain('class="step-result" tabindex="0" role="region" aria-label="Tool result"');

  for (const entries of [[...previous, completed], [...previous, completed, answer]]) {
    const html = render({ autoCollapse: false, entries }, bodies);
    const details = expectExpanded(html, work.length);
    expect(details[0]).toContain("First thought");
    expect(details[0]).toContain('class="markdown-body step-thinking-body"');
    expect(details[1]).toContain("first tool result");
    expect(details[4]).toContain("Second thought");
    expect(details[4]).toContain('class="markdown-body step-thinking-body"');
    expect(details.at(-1)).toContain('data-status="done"');
    expect(details.at(-1)).toContain("complete argument detail");
    expect(details.at(-1)).toContain("complete result beyond the head preview");
    expect(details.at(-1)).not.toContain("short head preview");
    expect(details.at(-1)).toContain('class="step-arguments" tabindex="0" aria-label="Tool arguments"');
    expect(details.at(-1)).toContain('class="step-result" tabindex="0" role="region" aria-label="Tool result"');
  }
});
