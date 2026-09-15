import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveActivity } from "./src/live-activity";
import { groupTranscriptEntries } from "./src/transcript-groups";

test("reasoning without text is activity, not a blank transcript card", () => {
  const entries = groupTranscriptEntries([
    { kind: "thinking", key: "empty", signature: "empty", text: "" },
    { kind: "thinking", key: "whitespace", signature: "whitespace", text: "\n " },
    { kind: "thinking", key: "actual", signature: "actual", text: "Actual summary" },
  ]);
  expect(entries).toHaveLength(1);
  expect(entries[0].kind === "details" && entries[0].entries.map(entry => entry.key)).toEqual(["actual"]);
  const thinking = renderToStaticMarkup(createElement(LiveActivity, { activity: "thinking" }));
  expect(thinking).toContain('role="status"');
  expect(thinking).toContain("THINKING");
  expect(renderToStaticMarkup(createElement(LiveActivity, { activity: "running" }))).toContain('role="status"');
  expect(renderToStaticMarkup(createElement(LiveActivity, { activity: "waiting_on_tool", tool: "exec_command" }))).toContain("EXEC_COMMAND");
  expect(renderToStaticMarkup(createElement(LiveActivity, { activity: "thinking", offline: "network" }))).not.toContain("THINKING");
  expect(renderToStaticMarkup(createElement(LiveActivity, { activity: "idle" }))).toBe("");
});
