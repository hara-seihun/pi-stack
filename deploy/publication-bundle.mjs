import { createHash } from "node:crypto";

const requestId = /^PUB-[a-f0-9]{24}$/;
const sha = /^[a-f0-9]{40}$/;
const error = (kind, detail) => ({ ok: false, error: { kind, detail } });
const member = request => ({ requestId: request.requestId, sourceSha: request.sourceSha, sourceRef: request.sourceRef });
const validMember = source => source && requestId.test(source.requestId) && sha.test(source.sourceSha)
  && source.sourceRef === `refs/heads/pi-stack-publications/${source.requestId}`;
const identity = sources => createHash("sha256").update(JSON.stringify(sources)).digest("hex");

export function sourceOnlyQueued(request) {
  return request.status === "queued" && request.attempt === 0 && request.step === "queued"
    && request.failures?.length === 0 && validMember(request)
    && !["startedAt", "waiting", "failure", "repairOf", "ownerRepairSourceSha", "integrationSha", "checks", "android", "hosts", "actionJournal",
      "reservations", "bootstrap", "maintenance", "nativeHistory", "recoveryInProgress", "sourceBundle", "sourceBundleOwner"]
      .some(key => request[key] !== undefined);
}

export function freezeSourceBundle(leader, requests, ready) {
  if (!sourceOnlyQueued(leader) || !ready(leader)) return error("ineligible-leader", leader.requestId);
  const sources = [member(leader), ...requests.filter(request => request.requestId !== leader.requestId && sourceOnlyQueued(request) && ready(request)).map(member)];
  if (new Set(sources.map(source => source.requestId)).size !== sources.length) return error("duplicate-member", leader.requestId);
  return { ok: true, bundle: { version: 1, id: identity(sources), ownerRequestId: leader.requestId, sources } };
}

export function sourceBundleMembers(request) {
  if (request.sourceBundle === undefined) return validMember(request)
    ? { ok: true, sources: [member(request)] } : error("invalid-source", request.requestId);
  const bundle = request.sourceBundle;
  if (bundle.version !== 1 || bundle.ownerRequestId !== request.requestId || !Array.isArray(bundle.sources) || bundle.sources.length === 0
    || !bundle.sources.every(validMember) || new Set(bundle.sources.map(source => source.requestId)).size !== bundle.sources.length
    || bundle.id !== identity(bundle.sources) || JSON.stringify(bundle.sources[0]) !== JSON.stringify(member(request))) {
    return error("invalid-bundle", request.requestId);
  }
  return { ok: true, sources: bundle.sources };
}

export function resolveSourceBundle(request, owner) {
  const binding = request.sourceBundleOwner;
  if (!binding || !owner || binding.requestId !== owner.requestId) return error("missing-bundle-owner", request.requestId);
  const members = sourceBundleMembers(owner);
  if (!members.ok) return members;
  if (owner.sourceBundle?.id !== binding.bundleId || !members.sources.some(source => JSON.stringify(source) === JSON.stringify(member(request)))) {
    return error("bundle-binding-mismatch", request.requestId);
  }
  if (owner.checks?.status === "passed" && owner.integratedAt && sha.test(owner.integrationSha) && sha.test(owner.baseSha)) {
    const evidence = { baseSha: owner.baseSha, integrationSha: owner.integrationSha, integratedAt: owner.integratedAt,
      checks: structuredClone(owner.checks), bundleEvidence: { ownerRequestId: owner.requestId, bundleId: binding.bundleId, integrationSha: owner.integrationSha } };
    if (owner.android) evidence.android = { ...structuredClone(owner.android), status: "prepared", hosts: {} };
    return { ok: true, state: "ready", evidence };
  }
  if (owner.status === "failed") return { ok: true, state: "failed", failure: structuredClone(owner.failure) };
  if (owner.status === "queued" || owner.status === "running") return { ok: true, state: "pending" };
  return error("invalid-owner-state", `${owner.requestId}: ${owner.status}`);
}

