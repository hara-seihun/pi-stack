import { expect, test } from "bun:test";
import { displayContextDocument } from "./context-display";
import { updateToolProgress, type ToolProgress } from "./tool-progress";

const canonical = { systemPrompt: "", tools: [], messages: [] as any[] };
const project = (tools: ToolProgress[], context = canonical) => JSON.parse(displayContextDocument(JSON.stringify(context), new Map(), undefined, tools));

test("restores live Pi tool output and removes its overlay when canonical context catches up", () => {
  let tool: ToolProgress = { id: "tool", name: "bash", args: { command: "pwd" }, startedAt: 1, output: "" };
  expect(project([tool]).messages[0].content[0]).toMatchObject({ type: "toolCall", id: tool.id, arguments: tool.args });
  tool = updateToolProgress(tool, "/home");
  tool = updateToolProgress(tool, "/home/kenan\n");
  const display = project([tool]);
  expect(display.messages[0].content[0].partialOutput).toBe("/home/kenan\n");
  expect(project(JSON.parse(JSON.stringify([tool])))).toEqual(display);
  tool = { ...tool, result: { content: [{ type: "text", text: tool.output }], timestamp: 2, isError: false } };
  const completed = project([tool]);
  expect(completed.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: tool.id, isError: false });
  expect(project([tool], completed)).toEqual(completed);
});

test("keeps textual reasoning and bounds live output without duplicating Pi snapshots", () => {
  const context = { ...canonical, messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "Actual summary" }] }] };
  expect(project([], context).messages[0].content[0].thinking).toBe("Actual summary");
  const tool: ToolProgress = { id: "tool", name: "bash", args: {}, startedAt: 1, output: "a" };
  expect(updateToolProgress(tool, "ab").output).toBe("ab");
  const bounded = updateToolProgress(tool, "x".repeat(40_000) + "latest").output;
  expect(bounded.length).toBe(20_001);
  expect(bounded.endsWith("latest")).toBe(true);
});
