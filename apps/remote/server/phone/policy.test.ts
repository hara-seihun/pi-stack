import { expect, test } from "bun:test";
import { callBrief, backendInstructions, instructions, type CallBrief } from "./policy";
const brief: CallBrief = { requestId: "4208e41f-cafe-4bc5-991f-02dcb8f0f723", to: "+15555550123", purpose: "Book Tuesday afternoon appointment", shareableFacts: ["Available Tuesday after 14:00"], opening: "Hello, I am Kenan, an AI assistant.", maxSeconds: 300 };
test("only durable approved recipient-facing fields enter the call", () => {
  expect(callBrief(brief)).toEqual({ ok: true, value: brief });
  for (const k of ["tools", "systemPrompt", "owner", "privateContext", "instructions", "threadId"]) expect(callBrief({ ...brief, [k]: "host-control" }).ok).toBe(false);
  for (const requestId of [undefined, "", "not-a-uuid"]) expect(callBrief({ ...brief, requestId }).ok).toBe(false);
  for (const maxSeconds of [undefined, null, 59, "300", 1801]) expect(callBrief({ ...brief, maxSeconds }).ok).toBe(false);
  expect(callBrief({ ...brief, maxSeconds: 60 }).ok).toBe(true);
  expect(callBrief({ ...brief, maxSeconds: 1800 }).ok).toBe(true);
});
test("the approved briefing feeds both existing reasoning and live speech", () => {
  expect(instructions(brief)).toContain(brief.purpose);
  expect(backendInstructions(brief)).toContain(brief.shareableFacts[0]);
  const privateValue = { ...brief, systemPrompt: "PRIVATE_INTERNAL_HISTORY" };
  expect(callBrief(privateValue).ok).toBe(false);
});
