import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceContinuation, repairSourceRef, canResumeCheckedRequest, failureSignature } from '../deploy/publication-continuation.mjs';
import { progressBudgetExhausted, policy } from '../deploy/publication-control.mjs';

const id = `PUB-${'a'.repeat(24)}`;
const sourceSha = 'b'.repeat(40);
const failure = { at: '2026-10-10T01:00:00Z', attempt: 1, step: 'checks', reason: 'test failed', command: 'node check' };
const request = { requestId: id, sourceSha: 'c'.repeat(40), sourceRef: `refs/heads/pi-stack-publications/${id}`, status: 'failed', attempt: 1, failure,
  failures: [failure], integrationSha: 'd'.repeat(40), checks: { status: 'failed' }, hosts: { local: { status: 'passed', proof: 'retained' } } };
const repair = { id: 'repair-1', failure };
const source = { sourceSha, sourceRef: repairSourceRef(id, sourceSha), at: '2026-10-10T01:01:00Z' };

test('source fix continues the original request, conserving failure/source and host proof history', () => {
  const result = sourceContinuation(request, repair, source);
  assert.equal(result.ok, true);
  const next = result.value;
  assert.equal(next.requestId, id);
  assert.equal(next.sourceSha, request.sourceSha);
  assert.equal(next.sourceRef, request.sourceRef);
  assert.equal(next.status, 'queued');
  assert.deepEqual(next.failures, [failure]);
  assert.deepEqual(next.integrationHistory[0].hosts, request.hosts);
  assert.equal(next.repairSources[0].sourceSha, sourceSha);
  assert.equal(next.checks, undefined);
  assert.equal(next.hosts, undefined, 'changed source needs fresh source-bound delivery');
  assert.equal(request.status, 'failed', 'historical input is not mutated');
});

test('continuation is idempotent after interruption, with identity conflict refused', () => {
  const next = sourceContinuation(request, repair, source).value;
  assert.equal(sourceContinuation(next, repair, source).changed, false);
  assert.equal(sourceContinuation(next, repair, { ...source, sourceSha: 'e'.repeat(40) }).error.kind, 'repair-identity-conflict');
});

test('stopped, stale and invalid source repairs cannot revive a request', () => {
  assert.equal(sourceContinuation({ ...request, failure: { ...failure, reason: 'cancelled' } }, repair, source).error.kind, 'stopped');
  assert.equal(sourceContinuation(request, { ...repair, explicitStop: true }, source).error.kind, 'stopped');
  assert.equal(sourceContinuation(request, { ...repair, failure: { ...failure, attempt: 0 } }, source).error.kind, 'stale-repair');
  assert.equal(sourceContinuation(request, repair, { ...source, sourceRef: 'refs/heads/main' }).error.kind, 'invalid-source');
});

test('checked interrupted publication resumes but unsettled source custody does not', () => {
  const running = { ...request, status: 'running', checks: { status: 'passed' } };
  assert.equal(canResumeCheckedRequest(running), true);
  for (const state of ['repair-required', 'resume-required']) assert.equal(canResumeCheckedRequest({ ...running, nativeHistory: { hosts: { local: { state } } } }), false);
  assert.equal(canResumeCheckedRequest({ ...running, recoveryInProgress: true }), false);
  assert.equal(canResumeCheckedRequest({ ...running, checks: { status: 'running' } }), false);
});

test('a passed integration displaced by main has a separate bounded recheck budget, not a failed-source retry', () => {
  const at = '2026-10-10T01:02:00Z', now = Date.parse(at);
  const movement = { integrationSha: 'd'.repeat(40), remoteMain: 'e'.repeat(40), attempt: 2, at, checks: { status: 'passed' },
    ref: `refs/pi-stack-publication/${id}/integrations/${'d'.repeat(40)}` };
  const queued = { requestId: id, status: 'queued', step: 'main-moved-recheck-required', attempt: 2, attemptLimit: 2,
    continuedRepair: { at: source.at }, mainMovements: [movement] };
  assert.equal(progressBudgetExhausted(queued, now), false, 'the last source-repair allowance cannot manufacture a defect after passing checks');
  assert.equal(progressBudgetExhausted(queued, now + policy.integrationRecheckLimitMs + 1), true);
  assert.equal(progressBudgetExhausted({ ...queued, mainMovements: Array(policy.maxIntegrationRechecks).fill(movement) }, now), true);
  for (const change of [{ checks: { status: 'failed' } }, { ref: 'unretained' }, { remoteMain: null }, { attempt: 1 }])
    assert.equal(progressBudgetExhausted({ ...queued, mainMovements: [{ ...movement, ...change }] }, now), true);
  assert.equal(progressBudgetExhausted({ ...queued, continuedRepair: { at: 'invalid' } }, now), true);
  assert.equal(progressBudgetExhausted({ ...queued, continuedRepair: { at: '2026-10-10T01:03:00Z' } }, now), true, 'a stale retained integration is not a current recheck');
  assert.equal(progressBudgetExhausted({ ...queued, step: 'queued-after-source-repair' }, now), true, 'ordinary failed-source attempts retain their own bound');
});

test('repeat defect identity excludes timestamps but separates changed command and step', () => {
  assert.equal(failureSignature(failure), failureSignature({ ...failure, at: 'later' }));
  assert.notEqual(failureSignature(failure), failureSignature({ ...failure, command: 'node different-check' }));
});
