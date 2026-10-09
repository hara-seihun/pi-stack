import { expect, it, vi } from "vitest";
import { convertToLlm, type AgentSession } from "@earendil-works/pi-coding-agent";
import { previewCurrentContext } from "../src/threads/pi-current-context.js";

function fixture() {
  const tool = { name: "current", description: "Current tool", parameters: { type: "object", properties: {} } };
  const session = { systemPrompt: "active instructions", messages: [
    { role: "system", content: "native instructions", toolsAdded: [{ ...tool, name: "retired" }], timestamp: 1 },
    { role: "user", content: "input", timestamp: 2 },
  ], agent: { state: { tools: [tool] }, convertToLlm, transformContext: undefined },
    getContextUsage: () => undefined, model: undefined } as unknown as AgentSession;
  return session;
}

it("previews pending tool changes through the same transforms without changing native declarations", async () => {
  const session = fixture(), before = structuredClone(session.messages);
  session.agent.transformContext = async messages => {
    messages[0] = { ...messages[0], content: "transformed instructions" } as typeof messages[0];
    return messages;
  };
  const result = await previewCurrentContext(session);
  expect(result).toMatchObject({ ok: true, value: { systemPrompt: "transformed instructions", tools: [{ name: "current" }] } });
  expect(session.messages).toEqual(before);
});

it("keeps transform failures and oversized source bodies typed, never entering conversion", async () => {
  const session = fixture(), convert = vi.fn(session.agent.convertToLlm);
  session.agent.convertToLlm = convert;
  session.agent.transformContext = async () => { throw new Error("fixture transform unavailable"); };
  expect(await previewCurrentContext(session)).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("fixture transform unavailable") } });
  session.agent.state.messages = [{ role: "user", content: "x".repeat(8 * 1024 * 1024), timestamp: 3 }];
  Object.defineProperty(session, "messages", { get: () => session.agent.state.messages });
  expect(await previewCurrentContext(session)).toMatchObject({ ok: false, error: { code: "oversized" } });
  expect(convert).not.toHaveBeenCalled();
});
