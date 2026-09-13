import { expect, test } from "bun:test";
import events from "./fixtures/codex-live-progress.json";
import { projectRuntimeEvent } from "./runtime-wire.mjs";
import { displayContextDocument } from "./context-display";
import { updateToolProgress, type ToolProgress } from "./tool-progress";

const native = events as any[];
const canonical = { systemPrompt: "", tools: [], messages: [native[0].message] };
const project = (tools: ToolProgress[], context = canonical) => JSON.parse(displayContextDocument(JSON.stringify(context), new Map(), undefined, tools));

test("replays the STP native tool deltas through Remote wire and restores the same display on reload", () => {
  const start = projectRuntimeEvent(native[1]);
  let tool: ToolProgress = { id: start.toolCallId, name: start.toolName, args: start.args, startedAt: native[1].timestamp, output: "" };
  let display = project([tool]);
  expect(display.messages[0].content).toEqual([]);
  expect(display.messages[1].content[0]).toMatchObject({ type: "toolCall", id: tool.id, arguments: start.args });
  for (const event of native.slice(2, -1)) {
    const projected = projectRuntimeEvent(event);
    expect(projected.toolCallId).toBe(tool.id);
    tool = updateToolProgress(tool, projected.partialResult.content[0].text, true);
  }
  expect(tool.output).toBe(native.at(-1).result.content[0].text);
  display = project([tool]);
  expect(display.messages[1].content[0].partialOutput).toContain('"verified_source_files": 66');
  expect(project(JSON.parse(JSON.stringify([tool])))).toEqual(display);
  const end = projectRuntimeEvent(native.at(-1));
  tool = { ...tool, result: { ...end.result, timestamp: native.at(-1).timestamp, isError: end.isError } };
  const completed = project([tool]);
  expect(completed.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: tool.id, isError: false });
  expect(project([tool], completed)).toEqual(completed);
  expect(canonical.messages[0].content).toEqual([{ type: "thinking", thinking: "" }]);
});

test("keeps textual reasoning and bounds live output without duplicating Pi snapshots", () => {
  const context = { ...canonical, messages: [{ ...native[0].message, content: [{ type: "thinking", thinking: "Actual summary" }] }] };
  expect(project([], context).messages[0].content[0].thinking).toBe("Actual summary");
  const tool: ToolProgress = { id: "tool", name: "bash", args: {}, startedAt: 1, output: "a" };
  expect(updateToolProgress(tool, "ab", false).output).toBe("ab");
  expect(updateToolProgress(tool, "b", true).output).toBe("ab");
  const bounded = updateToolProgress(tool, "x".repeat(40_000) + "latest", true).output;
  expect(bounded.length).toBe(20_001);
  expect(bounded.endsWith("latest")).toBe(true);
  const wire = projectRuntimeEvent({ type: "tool_execution_update", toolCallId: "tool", partialResult: { content: [{ type: "text", text: "x".repeat(100_000) }] } });
  expect(wire.partialResult.content[0].text.length).toBe(20_001);
});
