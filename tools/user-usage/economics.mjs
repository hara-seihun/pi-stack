import { COMPONENTS } from "./sessions.mjs";

const HOUR = 3_600_000;
const MAX_ALIGNMENT = 5 * 60_000;

function calibration(evidence, model, meter, monthDays, selectedAccounts) {
  const rates = Object.fromEntries(COMPONENTS.map(k => [k,
    model.pricedTokens[k] > 0 ? model.componentUsd[k] / model.pricedTokens[k] : null]));
  const samples = [], excluded = [];
  for (const account of evidence.accounts) {
    if (account.provider !== model.provider || account.use === "voice" ||
        selectedAccounts.length && !selectedAccounts.includes(account.id)) continue;
    const reject = reason => excluded.push({ accountId: account.id, reason });
    const readings = evidence.meters.filter(m => m.accountId === account.id && m.meterId === meter.id)
      .sort((a, b) => a.at - b.at);
    // Only the newest uninterrupted reset window can describe today's allowance.
    let start = 0;
    for (let i = 1; i < readings.length; i++) {
      if (readings[i].usedPercent < readings[i - 1].usedPercent ||
          readings[i].resetAt === null || readings[i - 1].resetAt === null ||
          Math.abs(readings[i].resetAt - readings[i - 1].resetAt) > 60_000) start = i;
    }
    const aligned = new Map();
    for (const reading of readings.slice(start)) {
      const hour = Math.round(reading.at / HOUR) * HOUR;
      if (hour > Math.floor(evidence.capturedAt / HOUR) * HOUR ||
          Math.abs(reading.at - hour) > MAX_ALIGNMENT) continue;
      const previous = aligned.get(hour);
      if (!previous || Math.abs(reading.at - hour) < Math.abs(previous.at - hour)) aligned.set(hour, reading);
    }
    const boundaries = [...aligned.keys()].sort((a, b) => a - b);
    if (boundaries.length < 2) { reject("No matched whole-hour meter span"); continue; }
    const from = boundaries[0], to = boundaries.at(-1), first = aligned.get(from), last = aligned.get(to);
    const delta = last.usedPercent - first.usedPercent;
    if (to - from < 3 * HOUR || evidence.capturedAt - last.at > 2 * HOUR ||
        first.resetAt === null || last.resetAt <= last.at || last.usedPercent >= 100 || delta < 5) {
      reject("Need a fresh, unsaturated span of at least 3 hours and 5 percentage points"); continue;
    }
    const hours = evidence.hours.filter(h => h.accountId === account.id && h.hour >= from && h.hour < to &&
      (meter.models === null || meter.models.includes(h.model)));
    const target = hours.filter(h => h.model === model.model && h.tokens > 0);
    const rawTokens = target.reduce((s, h) => s + h.tokens, 0);
    const allTokens = hours.reduce((s, h) => s + h.tokens, 0);
    if (rawTokens === 0 || rawTokens / allTokens < 0.999) {
      reject("Other models exceed 0.1% of tokens, or no matching usage was recorded"); continue;
    }
    if (target.some(h => !COMPONENTS.includes(h.component) || rates[h.component] === null)) {
      reject("The person's log has no price for a component used in calibration"); continue;
    }
    const apiUsd = target.reduce((s, h) => s + h.tokens * rates[h.component], 0);
    if (!(apiUsd > 0)) { reject("No positive logged price basis"); continue; }
    samples.push({ accountId: account.id, from, to, firstMeterAt: first.at, lastMeterAt: last.at,
      usedPercent: delta, tokens: rawTokens, apiUsd,
      ignoredOtherModelTokens: allTokens - rawTokens });
  }
  const usedPercent = samples.reduce((s, r) => s + r.usedPercent, 0);
  if (samples.length < 2 || usedPercent < 10) return { state: "unavailable", meterId: meter.id,
    reason: "Need at least two comparable accounts and ten pooled percentage points", samples, excluded };
  const monthlyWindows = monthDays * 24 / meter.windowHours;
  const capacity = (value, delta) => value / delta * 100 * monthlyWindows;
  const apiUsdPerPlanMonth = capacity(samples.reduce((s, r) => s + r.apiUsd, 0), usedPercent);
  return { state: "estimated", meterId: meter.id, samples, excluded, usedPercent,
    apiUsdPerPlanMonth,
    observedTokensPerPlanMonth: capacity(samples.reduce((s, r) => s + r.tokens, 0), usedPercent),
    observedApiCapacityRange: [Math.min(...samples.map(s => capacity(s.apiUsd, s.usedPercent))),
      Math.max(...samples.map(s => capacity(s.apiUsd, s.usedPercent)))],
    planMonths: model.loggedApiUsd / apiUsdPerPlanMonth };
}

export function estimateUsage(usage, evidence, { planUsd = 200, monthDays = 30, accounts = [] } = {}) {
  const finite = n => Number.isFinite(n) && n >= 0;
  const text = s => typeof s === "string" && s.length > 0;
  if (!evidence || evidence.version !== 1 || !finite(evidence.capturedAt) ||
      !Array.isArray(evidence.accounts) || !Array.isArray(evidence.hours) ||
      !Array.isArray(evidence.meters) || !Array.isArray(evidence.weeklyMeters) ||
      !evidence.accounts.every(a => a && text(a.id) && text(a.provider) && ["voice", "shared"].includes(a.use)) ||
      !evidence.hours.every(h => h && text(h.accountId) && text(h.model) && COMPONENTS.includes(h.component) && finite(h.hour) && finite(h.tokens)) ||
      !evidence.meters.every(m => m && text(m.accountId) && text(m.meterId) && finite(m.at) && finite(m.usedPercent) && m.usedPercent <= 100 && (m.resetAt === null || finite(m.resetAt))) ||
      !evidence.weeklyMeters.every(m => m && text(m.id) && text(m.provider) && finite(m.windowHours) && m.windowHours >= 168 && (m.models === null || Array.isArray(m.models) && m.models.every(text)))) {
    return { ok: false, error: "Unsupported or malformed usage-evidence snapshot" };
  }
  const models = usage.models.map(model => {
    const meters = evidence.weeklyMeters.filter(m => m.provider === model.provider &&
      (m.models === null || m.models.includes(model.model)));
    const estimates = model.unpricedResponses ? [] : meters.map(m => calibration(evidence, model, m, monthDays, accounts));
    const complete = estimates.length > 0 && estimates.every(e => e.state === "estimated");
    return { provider: model.provider, model: model.model, state: complete ? "estimated" : "unavailable",
      reason: complete ? null : model.unpricedResponses ? "Some responses have no logged API price"
        : meters.length === 0 ? "No supported weekly subscription meter" : "Insufficient comparable quota evidence",
      meters: estimates };
  });
  const providers = [...new Set(models.map(m => m.provider))].map(provider => {
    const mine = models.filter(m => m.provider === provider);
    if (mine.some(m => m.state !== "estimated")) return { provider, state: "unavailable", usd: null, planMonths: null };
    const buckets = new Map();
    for (const model of mine) for (const meter of model.meters) {
      buckets.set(meter.meterId, (buckets.get(meter.meterId) ?? 0) + meter.planMonths);
    }
    // A shared weekly bucket and a scoped bucket overlap; they are not additive bills.
    const planMonths = Math.max(...buckets.values());
    return { provider, state: "estimated", planMonths, usd: planMonths * planUsd };
  });
  const complete = providers.every(p => p.state === "estimated") && usage.missingUsage === 0;
  return { ok: true, value: { state: complete ? "estimated" : "partial", planUsd, monthDays,
    calibrationAt: evidence.capturedAt, models, providers,
    usd: complete ? providers.reduce((s, p) => s + p.usd, 0) : null,
    estimatedSubtotalUsd: providers.reduce((s, p) => s + (p.usd ?? 0), 0),
    assumptions: [
      "Each sampled subscription is treated as a plan at the requested monthly price.",
      "Weekly capacity is extrapolated to the requested month length; unused quota cannot be banked.",
      "Only shared accounts with at least 99.9% matching-model tokens are compared. Tiny other-model traffic is ignored.",
      "Token components are weighted by this person's logged API prices, not counted as equally expensive.",
      "Quota consumption is assumed to track those weights. Model mix, priority mode, context length and provider changes can alter it.",
      "Meters are matched to whole-hour usage within five minutes. Account samples are pooled before division.",
      "All usage on sampled accounts must reach this host's ledger. Use --accounts to exclude accounts used elsewhere.",
      "This is a prorated capacity estimate, not a bill. Five-hour burst limits and unreported limits are not monthly allowances.",
    ] } };
}
