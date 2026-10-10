import { createHash } from 'node:crypto';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export function repairSourceRef(requestId, sourceSha) {
  return `refs/heads/pi-stack-publications/${requestId}-repair-${sourceSha}`;
}

export function sourceContinuation(request, repair, source) {
  if (request.failure?.reason === 'cancelled' || repair.explicitStop) return { ok: false, error: { kind: 'stopped' } };
  if (request.continuedRepair?.repairId === repair.id) {
    return request.continuedRepair.sourceSha === source.sourceSha
      ? { ok: true, value: request, changed: false }
      : { ok: false, error: { kind: 'repair-identity-conflict' } };
  }
  if (request.status !== 'failed' || request.failure?.at !== repair.failure?.at || request.failure?.attempt !== repair.failure?.attempt)
    return { ok: false, error: { kind: 'stale-repair' } };
  if (!sha(source.sourceSha) || source.sourceRef !== repairSourceRef(request.requestId, source.sourceSha))
    return { ok: false, error: { kind: 'invalid-source' } };
  const value = structuredClone(request);
  const at = source.at;
  value.integrationHistory = [...(value.integrationHistory ?? []), {
    attempt: value.attempt, integrationSha: value.integrationSha, checks: value.checks, android: value.android,
    hosts: value.hosts, finalProof: value.finalProof, failure: value.failure, sourceBundleOwner: value.sourceBundleOwner,
    sourceSelection: value.sourceSelection, deliverySource: value.deliverySource, postServing: value.postServing,
  }];
  value.repairSources = [...(value.repairSources ?? []), { ...source, repairId: repair.id }];
  value.continuedRepair = { repairId: repair.id, sourceSha: source.sourceSha, at };
  value.status = 'queued';
  value.step = 'queued-after-source-repair';
  value.nextAttemptAt = at;
  for (const key of ['integrationSha', 'baseSha', 'checks', 'android', 'hosts', 'integratedAt', 'finalProof', 'failure',
    'waiting', 'blockedSince', 'progress', 'bundleEvidence', 'sourceBundleOwner', 'sourceSelection', 'deliverySource', 'postServing', 'mainPublication']) delete value[key];
  value.attemptLimit = (value.attempt ?? 0) + 1;
  return { ok: true, value, changed: true };
}

export function canResumeCheckedRequest(request) {
  return request.status === 'running' && (request.sourceSelection?.status === 'pinned' || request.checks?.status === 'passed') && sha(request.integrationSha)
    && !request.recoveryInProgress
    && !Object.values(request.nativeHistory?.hosts ?? {}).some(host => ['repair-required', 'resume-required'].includes(host.state));
}

export function failureSignature(failure) {
  return createHash('sha256').update(JSON.stringify({ step: failure?.step, reason: failure?.reason, command: failure?.command })).digest('hex');
}
