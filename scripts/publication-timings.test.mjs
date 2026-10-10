import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicationTimings, recordCommandTiming } from '../deploy/publication-timings.mjs';
const at = ms => new Date(ms).toISOString();
test('phase timing accumulates commands instead of replacing a long check with its report', () => {
  const request = {};
  recordCommandTiming(request, { step: 'checks', command: 'npm', startedAt: at(1000), completedAt: at(6000) });
  recordCommandTiming(request, { step: 'checks', command: 'curl', startedAt: at(6100), completedAt: at(6200) });
  assert.equal(request.stageTimings.checks.elapsedMs, 5100);
  assert.equal(request.stageTimings.checks.commands, 2);
  assert.equal(request.commandTimings.length, 2);
});
test('serving time requires passing host proof and keeps recovery latency', () => {
  const request = { requestId: 'r', sourceSha: 's', queuedAt: at(1000), integratedAt: at(1500), status: 'published', hosts: { a: { status: 'passed' }, b: { status: 'passed' } }, hostDelivery: { a: { startedAt: at(1800) }, b: { startedAt: at(1800) } }, integrationHistory: [{ failure: { at: at(500) }, integrationSha: 'old' }] };
  const result = publicationTimings(request, { a: { verifiedAt: at(2000) }, b: { verifiedAt: at(2200) } });
  assert.equal(result.sourceToIntegrationMs, 500);
  assert.equal(result.sourceToServingMs, 1200);
  assert.equal(result.hosts.b.hostDeliveryMs, 400);
  assert.equal(result.recoveries[0].failureToServingMs, 1700);
});
test('waiting and unknown times never claim serving completion', () => {
  const request = { queuedAt: at(1000), hosts: { a: { status: 'passed' }, b: { status: 'waiting' } } };
  assert.equal(publicationTimings(request, { a: { verifiedAt: at(2000) } }).sourceToServingMs, null);
  assert.equal(publicationTimings({ queuedAt: at(1000), hosts: { a: { status: 'passed' } } }).sourceToServingMs, null);
});
