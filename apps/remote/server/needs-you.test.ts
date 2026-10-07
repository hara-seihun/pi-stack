import { expect, test } from "bun:test";
import type { LifeEntity, LifeEntityInput, LifeProvenance, LifeSnapshot } from "kenan-memory/life-contract";
import type { ThreadQuestion } from "pi-orchestrator/api";
import { projectNeedsYou, readNeedsYouQuestions } from "./needs-you";

const provenance: LifeProvenance = { factClass: "stated", confidence: null, source: { actor: "person-a", locator: "thread-a", observedAt: "2026-10-07T08:00:00Z" }, evidence: [], counterevidence: [], validFrom: null, validUntil: null };
const entity = (id: string, value: LifeEntityInput): LifeEntity => ({ id, revision: 1, recordedAt: "2026-10-07T08:00:00Z", recordedBy: "person-a", threadId: "thread-a", value, status: "current", supersededBy: null, retractionReason: null });
const commitment = (person: string | null): Extract<LifeEntityInput, { kind: "commitment" }> => ({ kind: "commitment", title: "Arrange transport", provenance, state: "waiting", parties: ["person-a"], authority: null, origin: "thread-a", due: null, acceptance: "Transport arranged", dependencies: [], owner: person === null ? { kind: "kenan" } : { kind: "person", person }, nextAction: "Confirm pickup address", waiting: { for: "person", detail: "Address needed" }, goalId: null });
const question: ThreadQuestion = { id: "q1", threadId: "thread-a", question: "Which address?", suggestions: [{ id: "s1", text: "Home" }], recommendedSuggestionId: "s1", createdAt: 10 };
const pending = { questions: [question], threadIds: new Set(["thread-a"]), errors: [] };
const watch = { ok: true as const, value: { items: [{ id: "watch1", what: "Track delivery", why: "Need supplies", addedBy: "thread-a", nextDueAt: 100, createdAt: 0, updatedAt: 0 }] } };
const policy = { ok: true as const, value: { subject: "person-a", current: null, history: [] } };
const now = Date.parse("2026-10-07T10:00:00Z");

test("projection shows own waiting commitments and live questions, never Kenan work or watch items", () => {
  const snapshot: LifeSnapshot = { subject: "person-a", coverage: [], entities: [entity("mine", commitment("person-a")), entity("kenan", commitment(null)), entity("other", commitment("person-b")), entity("external", { ...commitment("person-a"), waiting: { for: "external", detail: "Waiting for the provider" } })] };
  const view = projectNeedsYou({ ok: true, value: snapshot }, pending, watch, policy, now);
  expect(view.items.map(item => item.id).sort()).toEqual(["life:mine", "question:q1"]);
  expect(view.items.find(item => item.id === "life:mine")).toMatchObject({ consequence: null, deadline: null, recommendation: null });
  expect(view.items.find(item => item.id === "question:q1")).toMatchObject({ recommendation: "Home", location: { threadId: "thread-a", questionId: "q1" } });
  expect(view.watch).toEqual({ state: "ready", value: { count: 1, nextDueAt: 100, lastActualCheck: null } });
});

test("life decisions enrich existing question owners and disappear when the owner is answered", () => {
  const decision: LifeEntityInput = { kind: "needs-you", title: "Confirm transport address", state: "open", reason: "missing-fact", consequence: "Booking waits for the address", recommendation: "Home", requiredBy: { at: "2026-10-08T12:00:00Z", timeZone: "Europe/London" }, commitmentId: "mine", questionId: "q1", provenance };
  const snapshot: LifeSnapshot = { subject: "person-a", entities: [entity("mine", commitment("person-a")), entity("decision", decision)], coverage: [] };
  const view = projectNeedsYou({ ok: true, value: snapshot }, pending, watch, policy, now);
  expect(view.items).toHaveLength(1);
  expect(view.items[0]).toMatchObject({ id: "life:decision", location: { threadId: "thread-a", questionId: "q1" }, commitmentId: "mine" });
  expect(projectNeedsYou({ ok: true, value: snapshot }, { ...pending, questions: [] }, watch, policy, now).items).toEqual([]);
});

test("reading a projection preserves reconciliation receipts and represents missing/error sources", () => {
  const coverage = { id: "calendar", revision: 1, recordedAt: "2026-10-07T08:00:00Z", recordedBy: "person-a", threadId: "thread-a", value: { source: "calendar", state: "partial" as const, checkedAt: "2026-10-07T08:00:00Z", reconciledAt: null, freshUntil: null, detail: null, error: "Calendar unavailable", evidence: [] } };
  const snapshot = { subject: "person-a", entities: [], coverage: [coverage] };
  const before = JSON.stringify(snapshot);
  const view = projectNeedsYou({ ok: true, value: snapshot }, { ...pending, errors: ["Owner unavailable"] }, watch, policy, now);
  expect(view.life).toEqual({ state: "ready", value: { coverage: [coverage] } });
  expect(JSON.stringify(snapshot)).toBe(before);
  expect(view.questions).toEqual({ state: "partial", errors: ["Owner unavailable"] });
  const failed = projectNeedsYou({ ok: false, error: "unavailable", message: "Life unavailable" }, pending, { ok: false, error: { code: "unavailable", message: "Watch unavailable" } }, policy, now);
  expect(failed.items).toHaveLength(1);
  expect(failed.life).toEqual({ state: "failed", error: "Life unavailable" });
  expect(failed.watch).toEqual({ state: "failed", error: "Watch unavailable" });
});

test("question scan includes archived owners and reports failed reads instead of empty success", async () => {
  const requests: unknown[] = [];
  const result = await readNeedsYouQuestions([{ id: "person", api: {
    questionEvents: (after = 0) => ({ ok: true, value: { cursor: 2, items: after === 0 ? [{ seq: 1, questionId: "q1", threadId: "thread-a", question: "Which address?", time: 10 }, { seq: 2, questionId: "q2", threadId: "unavailable", question: "Another question", time: 10 }] : [] } }),
    list: async input => { requests.push(input); return { ok: true, value: { threads: [{ id: "thread-a", title: "Archived", archived: true }, { id: "unavailable", title: "Unavailable" }] as any } }; },
    questions: async id => id === "thread-a" ? { ok: true, value: [question] } : { ok: false, error: { code: "unavailable", message: "Owner unavailable" } },
  } }], () => true);
  expect(requests).toEqual([{ limit: 100, cursor: undefined }]);
  expect(result.questions).toEqual([question]);
  expect(result.errors).toEqual(["Unavailable: Owner unavailable"]);
});
