import { expect, it } from "vitest";
import { validateWaitDependency } from "../src/threads/contracts.js";

it.each([
  { kind: "agents", threadIds: ["child"], after: { child: 12 } },
  { kind: "job", jobId: "gpu-123" },
  { kind: "deployment", publicationId: "PUB-123" },
  { kind: "message", fromThreadId: "collaborator" },
])("retains the exact named dependency $kind", dependency => {
  expect(validateWaitDependency(dependency)).toEqual({ ok: true, value: dependency });
});
it.each([
  { reason: "available for assignment", threadIds: [] },
  { kind: "agents", threadIds: [] },
  { kind: "agents", threadIds: ["child", "child"] },
  { kind: "agents", threadIds: ["child"], after: { foreign: 0 } },
  { kind: "agents", threadIds: ["child"], after: null },
  { kind: "job", jobId: "" },
  { kind: "deployment", publicationId: " " },
  { kind: "message", fromThreadId: null },
  { kind: "job", jobId: "job", threadIds: ["child"] },
  { kind: "anything_else", reason: "generic waiting" },
])("rejects missing, ambiguous and unspecified dependency: %j", dependency => {
  expect(validateWaitDependency(dependency)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
});

// Retained runners must interoperate with the upgraded owner without restart.
it.each([undefined, { child: 12 }])("normalizes an old wrapper's concrete child set request with cursors %j", after => {
  const input = { action: "set", reason: "Child result", threadId: "parent", requestId: "call", threadIds: ["child"], ...(after ? { after } : {}) };
  expect(validateWaitDependency(input)).toEqual({ ok: true, value: { kind: "agents", threadIds: ["child"], after: after ?? {} } });
  expect(input).not.toHaveProperty("kind");
});
it.each([
  { action: "set", threadIds: [] },
  { action: "set", threadIds: ["child", "child"] },
  { action: "set", threadIds: [" "] },
  { action: "set", threadIds: ["child"], after: { foreign: 0 } },
  { action: "set", threadIds: ["child"], after: { child: -1 } },
  { action: "set", threadIds: ["child"], jobId: "ambiguous" },
  { action: "set", threadIds: ["child"], kind: null },
  { action: "set", threadIds: ["child"], kind: "anything_else" },
  { action: "set", jobId: "job" },
  { action: "clear", threadIds: ["child"] },
  { threadIds: ["child"] },
])("does not relax old-wrapper validation: %j", input => {
  expect(validateWaitDependency(input)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
});
