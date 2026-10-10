const elapsed = (start, end) => {
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

export function publicationTimings(request, proofs = {}) {
  const hosts = Object.fromEntries(Object.entries(request.hosts ?? {}).map(([id, outcome]) => {
    const proof = proofs[id];
    const servingAt = outcome.status === 'passed' ? proof?.verifiedAt ?? outcome.android?.verifiedAt : null;
    const lane = request.hostDelivery?.[id];
    return [id, {
      status: outcome.status, servingAt,
      sourceToServingMs: servingAt ? elapsed(request.queuedAt, servingAt) : null,
      hostDeliveryMs: servingAt ? elapsed(lane?.startedAt, servingAt) : null,
      stages: lane?.timings ?? {},
    }];
  }));
  const finalServingAt = Object.values(hosts).map(host => host.servingAt).filter(Boolean).sort().at(-1) ?? null;
  return {
    requestId: request.requestId, sourceSha: request.sourceSha, integrationSha: request.integrationSha ?? null,
    status: request.status, queuedAt: request.queuedAt,
    sourceToIntegrationMs: elapsed(request.queuedAt, request.integratedAt),
    sourceToServingMs: Object.values(hosts).length > 0 && Object.values(hosts).every(host => host.status === 'passed')
      ? elapsed(request.queuedAt, finalServingAt) : null,
    stages: request.stageTimings ?? {}, hosts,
    recoveries: (request.integrationHistory ?? []).map(record => ({
      failedAt: record.failure?.at ?? null, failedIntegration: record.integrationSha ?? null,
      failureToServingMs: finalServingAt ? elapsed(record.failure?.at, finalServingAt) : null,
    })),
  };
}
