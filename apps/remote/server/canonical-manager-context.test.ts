import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { admitManagerContext, managerContextCapability, validateManagerContext, validateManagerContextResponse } from "./canonical-manager-context";
import type { ManagerPolicyBinding } from "./canonical-manager-policy";
const token = "a".repeat(64);
const binding: ManagerPolicyBinding = { version: 1, id: "work-route", direction: "incoming", source: { host: "converge-kenan", environment: "converge", scopeId: "remote:kenan", user: "kenan", uid: 1002 }, target: { host: "kenan-server", environment: "local", scopeId: "remote:kenan", user: "kenan", uid: 1000, managerThreadId: "canonical" }, origin: "http://127.0.0.1:18788", credentialSha256: createHash("sha256").update(token).digest("hex"), credentialFile: "/etc/pi-stack/manager-policy/work-route/token" };
const receive = { action: "receive", threadId: "canonical", requestId: "custody-ask:original", originThreadId: "work-child", questions: [{ id: "original:q", threadId: "work-child", question: "**Which rollout?**", suggestions: [{ id: "original:s", text: "Continue existing" }], recommendedSuggestionId: "original:s", createdAt: 17 }], deadlineAt: 7200017 };
const answer = { action: "answer", threadId: "canonical", requestId: "custody-answer:original", originThreadId: "work-child", answer: { threadId: "work-child", questionId: "original:q", selectedSuggestionIds: ["original:s"], text: "Continue", dismissed: false } };
const forwarded = { action: "transition", threadId: "work-child", requestId: "custody-forward:original", managerId: "canonical", questionId: "original:q", transition: { state: "forwarded", forwardedQuestionId: "canonical:q" } };
const settled = { ...forwarded, requestId: "custody-settle:original", transition: { state: "answered", answer: { selectedSuggestionIds: ["original:s"], text: "Continue", answeredBy: { kind: "manager", threadId: "canonical" } } } };
const envelope = (operation: string, input: unknown) => ({ version: 1, id: binding.id, source: binding.source, target: binding.target, operation, input });
test("same original enrollment has explicit reciprocal origin, not an arbitrary host or profile endpoint", () => {
  const capability = managerContextCapability(binding, "http://127.0.0.1:18789");
  expect(capability).toEqual({ ok: true, value: { version: 1, purpose: "canonical-work-context", binding, sourceOrigin: "http://127.0.0.1:18789" } });
  for (const origin of [binding.origin, "http://elsewhere:18789", "https://127.0.0.1:18789", "http://u:p@127.0.0.1:18789", "http://127.0.0.1:18789/v1/files", "http://127.0.0.1:18789?x=y", "http://127.0.0.1"])
    expect(managerContextCapability(binding, origin).ok).toBe(false);
});
test("original questions, deadlines, request identities and decisions pass only toward their native owner", () => {
  for (const input of [receive, answer, { ...answer, answer: { ...answer.answer, humanActivity: true } }]) {
    const request = validateManagerContext("managerQuestionCustody", input, binding);
    expect(request).toEqual({ ok: true, value: { operation: "managerQuestionCustody", input, destination: "target" } });
    expect(admitManagerContext(envelope("managerQuestionCustody", input), token, binding, "local").ok).toBe(true);
    expect(admitManagerContext(envelope("managerQuestionCustody", input), token, { ...binding, direction: "outgoing" }, "converge").ok).toBe(false);
  }
  for (const input of [forwarded, settled]) {
    expect(validateManagerContext("managerQuestionCustody", input, binding)).toEqual({ ok: true, value: { operation: "managerQuestionCustody", input, destination: "source" } });
    expect(admitManagerContext(envelope("managerQuestionCustody", input), token, { ...binding, direction: "outgoing" }, "converge").ok).toBe(true);
    expect(admitManagerContext(envelope("managerQuestionCustody", input), token, binding, "local").ok).toBe(false);
  }
});
test("identity, action and category boundaries reject generic send, account changes and invented custody", () => {
  for (const operation of ["send", "list", "read", "managerQuestions", "ask", "managerReplies", "unknown"])
    expect(validateManagerContext(operation, {}, binding).ok).toBe(false);
  for (const input of [{ ...receive, threadId: "another-manager" }, { ...receive, requestId: "" }, { ...receive, originThreadId: "canonical" }, { ...receive, questions: [] }, { ...receive, questions: [receive.questions[0], receive.questions[0]] }, { ...receive, deadlineAt: -1 }, { ...receive, privateContext: "forbidden" }, { ...receive, questions: [{ ...receive.questions[0], threadId: "another-child" }] }, { ...settled, managerId: "another-manager" }, { ...settled, transition: { state: "answered", answer: { ...settled.transition.answer, answeredBy: { kind: "manager", threadId: "another-manager" } } } }])
    expect(validateManagerContext("managerQuestionCustody", input, binding).ok).toBe(false);
  for (const forged of [{ ...envelope("managerQuestionCustody", receive), target: { ...binding.target, managerThreadId: "another" } }, { ...envelope("managerQuestionCustody", receive), source: { ...binding.source, user: "another" } }, { ...envelope("managerQuestionCustody", receive), version: 2 }, { ...envelope("managerQuestionCustody", receive), secret: token }])
    expect(admitManagerContext(forged, token, binding, "local").ok).toBe(false);
  expect(admitManagerContext(envelope("managerQuestionCustody", receive), "b".repeat(64), binding, "local").ok).toBe(false);
});
test("reciprocal reads expose only work summary or exact origin title, never personal transcripts or secret fields", () => {
  const source = { ...binding, direction: "outgoing" as const };
  for (const [operation, input] of [["managerWorkSummary", {}], ["questionOrigin", { threadId: "work-child" }]] as const) {
    expect(admitManagerContext(envelope(operation, input), token, source, "converge").ok).toBe(true);
    expect(admitManagerContext(envelope(operation, input), token, binding, "local").ok).toBe(false);
  }
  const summary = validateManagerContext("managerWorkSummary", {}, binding); if (!summary.ok) throw new Error("fixture");
  expect(validateManagerContextResponse({ ok: true, value: { activeWork: true, lastHumanMessageAt: 9 } }, summary.value).ok).toBe(true);
  for (const value of [{ activeWork: true, lastHumanMessageAt: 9, token }, { activeWork: true }, { activeWork: true, lastHumanMessageAt: -1 }, { transcript: "private" }])
    expect(validateManagerContextResponse({ ok: true, value }, summary.value).ok).toBe(false);
  const origin = validateManagerContext("questionOrigin", { threadId: "work-child" }, binding); if (!origin.ok) throw new Error("fixture");
  expect(validateManagerContextResponse({ ok: true, value: { id: "work-child", title: "Existing rollout" } }, origin.value).ok).toBe(true);
  for (const value of [{ id: "another", title: "wrong" }, { id: "work-child", title: "Task", cwd: "/private" }, { id: "work-child", title: "Task", messages: [] }])
    expect(validateManagerContextResponse({ ok: true, value }, origin.value).ok).toBe(false);
  const custody = validateManagerContext("managerQuestionCustody", receive, binding); if (!custody.ok) throw new Error("fixture");
  expect(validateManagerContextResponse({ ok: true, value: { accepted: true } }, custody.value)).toEqual({ ok: true, value: { accepted: true } });
  for (const value of [{ accepted: false }, { accepted: true, questionIds: ["invented"] }, {}])
    expect(validateManagerContextResponse({ ok: true, value }, custody.value).ok).toBe(false);
});
