import { expect, test } from "bun:test";
import type { LifeClient, LifeEntity, LifeEntityInput, LifeRequest, LifeSnapshot } from "kenan-memory/life-contract";
import { commitmentReminderDismissed, dismissNeedsYou, parseNeedsYouDismissal, type DismissalOwners } from "./needs-you-dismissal";
import { projectNeedsYou } from "./needs-you";

const now = "2026-10-08T02:00:00Z";
const provenance = { factClass: "stated" as const, confidence: null, source: { actor: "person-a", locator: "thread-a", observedAt: now }, evidence: [], counterevidence: [], validFrom: null, validUntil: null };
const need: LifeEntityInput = { kind: "needs-you", state: "open", title: "Choose transport", reason: "decision", consequence: null, recommendation: null, requiredBy: null, commitmentId: null, questionId: null, provenance };
const commitment: LifeEntityInput = { kind: "commitment", state: "waiting", title: "Arrange transport", parties: [], authority: null, origin: "thread-a", due: null, acceptance: "Transport arranged", dependencies: [], owner: { kind: "person", person: "person-a" }, nextAction: "Confirm address", waiting: { for: "person", detail: "Address" }, goalId: null, provenance };
function version(id: string, value: LifeEntityInput): LifeEntity { return { id, value, revision: 1, status: "current", recordedAt: now, recordedBy: "person-a", threadId: "thread-a", supersededBy: null, retractionReason: null }; }
function fixture(entities: LifeEntity[]) {
  const snapshot: LifeSnapshot = { subject: "person-a", entities, coverage: [] }, writes: LifeRequest[] = [], questions: string[] = [];
  let failWrite = false;
  const client = { request: async (request: LifeRequest) => {
    if (request.operation === "read") return { ok: true, value: snapshot };
    if (request.operation !== "put-entity") throw new Error("Unexpected operation");
    writes.push(request);
    const index = snapshot.entities.findIndex(entity => entity.id === request.id), previous = snapshot.entities[index];
    if (failWrite || (previous === undefined ? 0 : previous.revision) !== request.expectedRevision) return { ok: false, error: "conflict", message: "Changed concurrently" };
    const entity = { ...version(request.id, request.entity), revision: request.expectedRevision + 1 };
    if (index < 0) snapshot.entities.push(entity); else snapshot.entities[index] = entity;
    return { ok: true, value: entity };
  } } as LifeClient;
  const owners: DismissalOwners = { client, now, findQuestion: async () => ({ ok: true, threadId: "thread-a" }), dismissQuestion: async (threadId, id) => { questions.push(`${threadId}:${id}`); return { ok: true }; } };
  return { snapshot, writes, questions, owners, failWrite: () => { failWrite = true; } };
}
const pending = { questions: [], threadIds: new Set(["thread-a"]), errors: [] };
const watch = { ok: true as const, value: { items: [] } };
const policy = { ok: true as const, value: { subject: "person-a", current: null, history: [] } };

test("dismissal targets reject forged scope, unset revisions and unknown variants", () => {
  expect(parseNeedsYouDismissal({ kind: "life", id: "need", revision: 1 })).toEqual({ kind: "life", id: "need", revision: 1 });
  for (const input of [{ kind: "life", id: "need" }, { kind: "life", id: "need", revision: 0 }, { kind: "life", id: "need", revision: 1, person: "person-b" }, { kind: "delete", id: "need", revision: 1 }]) expect(parseNeedsYouDismissal(input)).toBeNull();
});

test("dismissal durably sets the life need state using its exact revision and it disappears on a fresh projection", async () => {
  const f = fixture([version("need", need)]);
  expect(await dismissNeedsYou({ kind: "life", id: "need", revision: 1 }, f.owners)).toEqual({ ok: true });
  expect(f.writes[0]).toMatchObject({ target: { scope: "self" }, expectedRevision: 1, entity: { state: "dismissed" } });
  expect(projectNeedsYou({ ok: true, value: f.snapshot }, pending, watch, policy, Date.parse(now)).items).toEqual([]);
});

test("stale cards and someone else's commitments cannot mutate owner state", async () => {
  const f = fixture([version("need", need), version("other", { ...commitment, owner: { kind: "person", person: "person-b" } })]);
  expect(await dismissNeedsYou({ kind: "life", id: "need", revision: 2 }, f.owners)).toMatchObject({ ok: false, error: "conflict" });
  expect(await dismissNeedsYou({ kind: "commitment", id: "other", revision: 1 }, f.owners)).toMatchObject({ ok: false, error: "invalid-state" });
  expect(f.writes).toEqual([]);
});

test("a dismissed commitment reminder survives rereads without cancelling the obligation; a new revision resurfaces", async () => {
  const original = version("commitment", commitment), f = fixture([original]);
  expect(await dismissNeedsYou({ kind: "commitment", id: original.id, revision: 1 }, f.owners)).toEqual({ ok: true });
  expect(original.value).toEqual(commitment);
  expect(commitmentReminderDismissed(original, f.snapshot.entities)).toBe(true);
  expect(projectNeedsYou({ ok: true, value: f.snapshot }, pending, watch, policy, Date.parse(now)).items).toEqual([]);
  expect(commitmentReminderDismissed({ ...original, revision: 2 }, f.snapshot.entities)).toBe(false);
});

test("question dismissal reaches the original owner, including linked life needs, and partial effects are explicit", async () => {
  const f = fixture([version("need", { ...need, questionId: "q", commitmentId: "commitment" }), version("commitment", commitment)]);
  expect(await dismissNeedsYou({ kind: "question", threadId: "thread-b", questionId: "q2" }, f.owners)).toEqual({ ok: true });
  expect(await dismissNeedsYou({ kind: "life", id: "need", revision: 1 }, f.owners)).toEqual({ ok: true });
  expect(f.questions).toEqual(["thread-b:q2", "thread-a:q"]);
  expect(projectNeedsYou({ ok: true, value: f.snapshot }, pending, watch, policy, Date.parse(now)).items).toEqual([]);
  const partial = fixture([version("need", { ...need, questionId: "q" })]); partial.failWrite();
  expect(await dismissNeedsYou({ kind: "life", id: "need", revision: 1 }, partial.owners)).toMatchObject({ ok: false, error: "conflict", questionDismissed: true });
});
