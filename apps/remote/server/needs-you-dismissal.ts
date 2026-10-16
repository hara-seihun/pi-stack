import { createHash } from "node:crypto";
import type { LifeClient, LifeEntity, LifeEntityInput, LifeSnapshot } from "kenan-memory/life-contract";
import type { NeedsYouDismissal, NeedsYouDismissResult } from "../shared/needs-you";

export function commitmentDismissalId(id: string): string {
  return `attention-dismissal:${createHash("sha256").update(id).digest("hex")}`;
}
export function commitmentReminderDismissed(entity: LifeEntity, current: readonly LifeEntity[]): boolean {
  return current.some(marker => marker.value.kind === "needs-you" && marker.value.state === "dismissed" && marker.value.commitmentId === entity.id &&
    marker.value.provenance.evidence.some(value => value.kind === "life" && value.id === entity.id && value.relation === `attention-dismissed-revision:${entity.revision}`));
}
export function parseNeedsYouDismissal(input: unknown): NeedsYouDismissal | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const id = (candidate: unknown) => typeof candidate === "string" && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(candidate);
  if (value.kind === "question" && Object.keys(value).length === 3 && id(value.threadId) && id(value.questionId)) return value as NeedsYouDismissal;
  if ((value.kind === "life" || value.kind === "commitment") && Object.keys(value).length === 3 && id(value.id) && Number.isSafeInteger(value.revision) && Number(value.revision) > 0) return value as NeedsYouDismissal;
  return null;
}
export type DismissalOwners = {
  client: LifeClient;
  dismissQuestion(threadId: string, questionId: string): Promise<NeedsYouDismissResult>;
  findQuestion(questionId: string): Promise<{ ok: true; threadId: string | null } | { ok: false; message: string }>;
  now: string;
};
export async function dismissNeedsYou(target: NeedsYouDismissal, owners: DismissalOwners): Promise<NeedsYouDismissResult> {
  if (target.kind === "question") return owners.dismissQuestion(target.threadId, target.questionId);
  const loaded = await owners.client.request<LifeSnapshot>({ operation: "read", target: { scope: "self" } });
  if (!loaded.ok) return loaded;
  const snapshot = loaded.value, current = snapshot.entities.filter(entity => entity.status === "current");
  const entity = current.find(entity => entity.id === target.id);
  if (!entity) return { ok: false, error: "not-found", message: "This need no longer exists. Refresh the view." };
  if (entity.revision !== target.revision) return { ok: false, error: "conflict", message: "This need changed. Refresh before dismissing it." };
  const value = entity.value;
  if (target.kind === "commitment") {
    if (value.kind !== "commitment" || value.state !== "waiting" || value.waiting?.for !== "person" || value.owner.kind !== "person" || value.owner.person !== snapshot.subject) return { ok: false, error: "invalid-state", message: "This is not your waiting commitment reminder." };
    const id = commitmentDismissalId(entity.id), previous = current.find(entity => entity.id === id);
    const marker: LifeEntityInput = { kind: "needs-you", state: "dismissed", title: value.title, reason: "person-only-action", consequence: null, recommendation: null, requiredBy: value.due, commitmentId: entity.id, questionId: null,
      provenance: { factClass: "stated", confidence: null, source: { actor: snapshot.subject, locator: "pi-remote:attention-dismiss", observedAt: owners.now },
        evidence: [{ kind: "life", id: entity.id, relation: `attention-dismissed-revision:${entity.revision}` }], counterevidence: [], validFrom: owners.now, validUntil: null } };
    const written = await owners.client.request({ operation: "put-entity", target: { scope: "self" }, id, expectedRevision: previous === undefined ? 0 : previous.revision, entity: marker });
    return written.ok ? { ok: true } : written;
  }
  if (value.kind !== "needs-you") return { ok: false, error: "invalid-state", message: "This is not a personal need." };
  if (value.state === "dismissed") return { ok: true };
  if (value.state !== "open") return { ok: false, error: "invalid-state", message: "This need is already settled." };
  let questionDismissed = false;
  if (value.questionId !== null) {
    const found = await owners.findQuestion(value.questionId);
    if (!found.ok) return { ok: false, error: "unavailable", message: found.message };
    if (found.threadId !== null) {
      const result = await owners.dismissQuestion(found.threadId, value.questionId);
      if (!result.ok) return result;
      questionDismissed = true;
    }
  }
  const linkedCommitment = value.commitmentId === null ? undefined : current.find(entity => entity.id === value.commitmentId && entity.value.kind === "commitment");
  const written = await owners.client.request({ operation: "put-entity", target: { scope: "self" }, id: entity.id, expectedRevision: target.revision,
    entity: { ...value, state: "dismissed", provenance: { ...value.provenance, factClass: "stated", source: { actor: snapshot.subject, locator: "pi-remote:attention-dismiss", observedAt: owners.now },
      evidence: [...value.provenance.evidence.slice(-98), { kind: "life", id: entity.id, relation: `Dismissed from Attention at revision ${target.revision}` },
        ...(linkedCommitment === undefined ? [] : [{ kind: "life" as const, id: linkedCommitment.id, relation: `attention-dismissed-revision:${linkedCommitment.revision}` }])] } } });
  return written.ok ? { ok: true } : { ...written, ...(questionDismissed ? { questionDismissed: true, message: `The question was dismissed, but its life record could not be updated: ${written.message}` } : {}) };
}
