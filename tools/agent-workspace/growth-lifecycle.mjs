import { createHash } from 'node:crypto';

export class GrowthLifecycleError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const digest = value => createHash('sha256').update(value).digest('hex');
export function growthError(code, message) { throw new GrowthLifecycleError(code, message); }

// Retirement is a separate dimension from source/runtime custody and original pricing.
// It does not pretend that historical growth or physical allocation disappeared.
export function retainedGrowth(plan) {
  if (plan.growthLifecycle === undefined) return false;
  const value = plan.growthLifecycle;
  if (value?.kind !== 'retired-future-growth' || value.remainingGrowthBytes !== 0 ||
      !['source', 'runtime'].includes(value.retainedUse) ||
      !/^[a-f0-9]{64}$/u.test(value.dispositionSha256) ||
      !Number.isSafeInteger(value.retiredAt) || value.retiredAt < 0) {
    growthError('invalid-growth-lifecycle', 'unknown or invalid growth lifecycle');
  }
  return true;
}

export function validateRetirement(disposition, binding, safety, now = Date.now()) {
  if (disposition?.kind !== 'retire-future-growth' ||
      !['source', 'runtime'].includes(disposition.retainedUse) ||
      disposition.remainingGrowthBytes !== 0 || disposition.growthWriters !== 'none' || disposition.writingLease !== 'retire' ||
      typeof disposition.reason !== 'string' || !disposition.reason.trim() ||
      typeof disposition.ownerEvidence !== 'string' || !disposition.ownerEvidence.trim()) {
    growthError('invalid-growth-disposition', 'explicit zero-future-growth owner disposition and evidence required');
  }
  if (disposition.binding === null || typeof disposition.binding !== 'object' ||
      Object.keys(binding).some(key => disposition.binding[key] !== binding[key]) ||
      Object.keys(disposition.binding).some(key => !(key in binding))) {
    growthError('stale-growth-disposition', 'owner, source, plan, sample or root identity changed; obtain a fresh binding');
  }
  if (!Number.isSafeInteger(disposition.observedAt) || disposition.observedAt > now ||
      now - disposition.observedAt > 15 * 60_000) {
    growthError('stale-growth-disposition', 'owner disposition must be current, not future-dated');
  }
  if (!Array.isArray(safety.references) || !Array.isArray(safety.errors)) {
    growthError('growth-writer-unknown', 'growth writer observation is unset');
  }
  if (safety.errors.length) growthError('growth-writer-unknown', safety.errors.join('; '));
  if (safety.references.length) growthError('growth-writer-active', 'runtime/thread/process references remain; no read-only assumption permitted');
}
