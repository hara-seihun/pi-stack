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
