import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { boundedArguments } from "../server/transcript-items";
import { ToolStep, WorkEntry } from "./src/features/conversation/Transcript";
import { ThreadDirectoryProvider, type ThreadDirectory } from "./src/features/conversation/thread-chips";
import { managerToolSummary } from "./src/features/conversation/tool-summary";
import type { ContextEntry } from "./src/types";

globalThis.location ??= new URL("https://router.test/") as unknown as Location;

const peers = Array.from({ length: 7 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const args = { action: "set", kind: "agents", threadIds: peers, reason: "Raw dependency reasoning" };
const bounded = boundedArguments(args, 120, "thread_wait");
const wait: ContextEntry = { kind: "toolCall", key: "wait", signature: "wait", argumentsTruncated: true,
  toolCall: { name: "functions.thread_wait", arguments: bounded.value },
  toolResult: { preview: '{"ok":true,"value":{"waitingOnAgents":{}}}', size: 500, isError: false } };
const directory: ThreadDirectory = { name: id => `Child ${id}`, busy: () => false, discover() {}, lookupError: () => null, open() {} };
const noAction = () => {};
const render = (entry: ContextEntry, mono: boolean) => renderToStaticMarkup(<ThreadDirectoryProvider value={directory}>
  <WorkEntry entry={entry} sessionId="manager" home="/work" mono={mono} autoCollapse={false} onEdit={noAction} onReply={noAction} />
</ThreadDirectoryProvider>);

test("manager's first activity disclosure is readable, never raw arguments/results or child chips", () => {
  for (const entry of [wait, { ...wait, toolResult: undefined }, { ...wait, toolResult: { ...wait.toolResult, isError: true } }]) {
    const html = render(entry, true);
    expect(html).toContain(entry.toolResult ? "Waited for 7 agents" : "Waiting for 7 agents");
    expect(html.match(/^<details\b[^>]*>/)?.[0]).not.toContain('open=""');
    expect(html).not.toContain("step-arguments");
    expect(html).not.toContain("step-result");
    expect(html).not.toContain("thread-chip");
    expect(html).not.toContain("Raw dependency reasoning");
    expect(html).not.toContain(peers[0]);
    expect(html).not.toContain("waitingOnAgents");
  }
});

test("the explicit deeper disclosure retains complete raw details and child navigation", () => {
  const html = renderToStaticMarkup(<ThreadDirectoryProvider value={directory}><ToolStep entry={wait} home="/work" progressive forceExpanded /></ThreadDirectoryProvider>);
  expect(html.match(/^<details\b[^>]*>/)?.[0]).toContain('open=""');
  expect(html).toContain("Waited for 7 agents");
  expect(html).toContain("step-arguments");
  expect(html).toContain("step-result");
  expect(html).toContain("thread-chip");
  expect(html).toContain("Raw dependency reasoning");
  expect(html).toContain("waitingOnAgents");
});

test("classic expanded activity keeps its existing raw tools and chips", () => {
  const html = render(wait, false);
  expect(html.match(/^<details\b[^>]*>/)?.[0]).toContain('open=""');
  expect(html).toContain("step-arguments");
  expect(html).toContain("step-result");
  expect(html).toContain("thread-chip");
});

test("mono activity messages and JSON notices have their own initially closed disclosure", () => {
  const incoming: ContextEntry = { kind: "user", key: "incoming", signature: "incoming", text: "Worker report", agentSender: { threadId: peers[0], name: "Worker" } };
  const outgoing: ContextEntry = { kind: "toolCall", key: "send", signature: "send", toolCall: { name: "thread_send", arguments: { threadId: peers[0], text: "Assignment" } } };
  for (const entry of [incoming, outgoing]) {
    const html = render(entry, true);
    expect(html.match(/<details\b[^>]*>/)?.[0]).not.toContain('open=""');
    expect(html).toContain("agent-route");
  }
  const notice = render({ kind: "notice", key: "notice", signature: "notice", text: '{"raw_notice":"internal state"}' }, true);
  expect(notice).not.toContain("raw_notice");
  expect(notice).not.toContain("step-detail");
});

test("bounded heads retain the true agent count; historical unknown counts are not guessed", () => {
  expect((bounded.value as typeof args & { threadCount: number }).threadIds).toHaveLength(5);
  expect((bounded.value as { threadCount: number }).threadCount).toBe(7);
  expect(managerToolSummary("thread_wait", bounded.value, "/work", false, false)).toBe("Waited for 7 agents");
  expect(managerToolSummary("thread_wait", { kind: "agents", threadIds: peers.slice(0, 5) }, "/work", false, false)).toBe("Waited for agents");
  expect(managerToolSummary("thread_await", { threadIds: [peers[0]] }, "/work", true, true)).toBe("Waiting for 1 agent");
  expect(managerToolSummary("functions.bash", { command: "raw command" }, "/work", false, true)).toBe("Ran bash");
  expect(managerToolSummary("custom_tool", { raw: "private JSON" }, "/work", false, true)).toBe("Tool: custom tool");
});
