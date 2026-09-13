import { expect, it } from "vitest";
import { CodexProjection } from "../src/cores/codex-projection.js";
import type { CoreOutput } from "../src/cores/contracts.js";
import type { ThreadItem } from "../src/cores/codex-protocol/v2/ThreadItem.js";
import type { Turn } from "../src/cores/codex-protocol/v2/Turn.js";

const reasoning: ThreadItem = { type: "reasoning", id: "reasoning", summary: [], content: [] };
function fixture() {
  const events: CoreOutput[] = [];
  const projection = new CodexProjection(() => "gpt-6-astra", event => events.push(structuredClone(event)), () => 1000);
  return { projection, events };
}

it("reports reasoning activity without inventing a blank completed message", () => {
  const { projection, events } = fixture();
  projection.item(reasoning, "turn", false);
  expect(projection.liveState()).toMatchObject({ isThinking: true, thinking: "" });
  expect(events.at(-1)).toMatchObject({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } });
  projection.item(reasoning, "turn", true);
  expect(events.at(-1)).toMatchObject({ type: "message_update", assistantMessageEvent: { type: "thinking_end", content: "" } });
  expect(events.some(event => event.type === "message_end")).toBe(false);
  expect(projection.entries).toEqual([]);
  expect(projection.liveState().isThinking).toBe(false);
  projection.restore([{ id: "saved", status: "completed", items: [reasoning] } as Turn]);
  expect(projection.entries).toEqual([]);
});

it("keeps actual streamed reasoning when native completion omits the summary", () => {
  const { projection, events } = fixture();
  projection.item(reasoning, "turn", false);
  projection.delta(reasoning.id, "Checking dimensions.", true);
  projection.item(reasoning, "turn", true);
  expect(events.find(event => (event.assistantMessageEvent as { type?: string } | undefined)?.type === "thinking_end")?.assistantMessageEvent).toMatchObject({ content: "Checking dimensions." });
  expect(projection.entries[0].message.content).toEqual([{ type: "thinking", thinking: "Checking dimensions." }]);
  expect(projection.liveState()).toMatchObject({ thinking: "", isThinking: false });
});

it("restores an active native tool without fabricating a completed result", () => {
  const { projection, events } = fixture();
  const command = { type: "commandExecution", id: "command", command: "run-experiment", cwd: "/work", status: "inProgress", aggregatedOutput: null, exitCode: null } as ThreadItem;
  projection.restore([{ id: "turn", status: "inProgress", items: [command] } as Turn]);
  expect(projection.entries).toEqual([]);
  expect(projection.liveState().tools).toEqual([{ toolCallId: "command", toolName: "exec_command", args: { command: "run-experiment", cwd: "/work" } }]);
  projection.item({ ...command, status: "completed", exitCode: 0, aggregatedOutput: "result" } as ThreadItem, "turn", true);
  expect(projection.liveState().tools).toEqual([]);
  expect(events.some(event => event.type === "tool_execution_end")).toBe(true);
  expect(projection.entries.at(-1)?.message).toMatchObject({ role: "toolResult", content: [{ type: "text", text: "result" }] });
});

it("clears unfinished reasoning when its native turn is interrupted", () => {
  const { projection } = fixture();
  projection.item(reasoning, "turn", false);
  projection.finish({ id: "turn", status: "interrupted", items: [] } as unknown as Turn);
  expect(projection.liveState()).toEqual({ text: "", thinking: "", isThinking: false, tools: [] });
});
