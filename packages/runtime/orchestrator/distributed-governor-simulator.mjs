#!/usr/bin/env node

const HOUR_MS = 3_600_000;

export class Random {
  constructor(seed) {
    this.state = BigInt.asUintN(64, BigInt(seed) || 1n);
    this.spare = null;
  }

  next() {
    this.state += 0x9e3779b97f4a7c15n;
    let value = this.state;
    value = (value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n;
    value = (value ^ (value >> 27n)) * 0x94d049bb133111ebn;
    value ^= value >> 31n;
    return Number(BigInt.asUintN(53, value)) / 2 ** 53;
  }

  normal() {
    if (this.spare !== null) {
      const value = this.spare;
      this.spare = null;
      return value;
    }
    const radius = Math.sqrt(-2 * Math.log(Math.max(Number.MIN_VALUE, this.next())));
    const angle = 2 * Math.PI * this.next();
    this.spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  }

  bool(probability = 0.5) { return this.next() < probability; }
  integer(maximum) { return Math.floor(this.next() * maximum); }
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values) {
  if (!values.length) return Number.NaN;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function percentile(values, fraction) {
  if (!values.length) return Number.NaN;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.round((ordered.length - 1) * fraction)];
}

function linearSlope(points) {
  if (points.length < 2) return null;
  const xMean = mean(points.map((point) => point.at));
  const yMean = mean(points.map((point) => point.used));
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.at - xMean) * (point.used - yMean);
    denominator += (point.at - xMean) ** 2;
  }
  return denominator > 0 ? numerator / denominator : null;
}

function jain(values) {
  if (!values.length) return 1;
  const sum = values.reduce((total, value) => total + value, 0);
  const squares = values.reduce((total, value) => total + value ** 2, 0);
  return squares > 0 ? sum ** 2 / (values.length * squares) : 1;
}

function demandMultiplier(kind, at, hostIndex, random, state) {
  if (kind === "constant") return 1;
  if (kind === "diurnal") {
    return 0.65 + 0.5 * (1 + Math.sin(2 * Math.PI * (at / 24 + hostIndex * 0.137))) / 2;
  }
  if (kind === "bursty") {
    if (state.burstRemaining > 0) {
      state.burstRemaining--;
      return state.burstMagnitude;
    }
    if (random.bool(0.012)) {
      state.burstRemaining = 2 + random.integer(18);
      state.burstMagnitude = 2 + 5 * random.next();
      return state.burstMagnitude;
    }
    return 0.15 + 0.35 * random.next();
  }
  if (kind === "correlated-bursty") {
    const wave = Math.sin(at * 1.71) + Math.sin(at * 0.193 + 1.2);
    return wave > 1.1 ? 5 : wave < -1.1 ? 0.08 : 0.65;
  }
  if (kind === "adversarial-square") {
    return Math.floor(at / 3) % 2 ? 5 : 0.05;
  }
  return 1;
}

function modelCostsAt(scenario, at) {
  const costs = [...scenario.modelCosts];
  if (scenario.costDrift) {
    const start = scenario.costDrift.atHour;
    if (at >= start) {
      const progress = scenario.costDrift.durationHours <= 0
        ? 1
        : clamp((at - start) / scenario.costDrift.durationHours, 0, 1);
      for (let model = 0; model < costs.length; model++) {
        const multiplier = scenario.costDrift.multipliers[model] ?? 1;
        costs[model] *= 1 + (multiplier - 1) * progress;
      }
    }
  }
  return costs;
}

function hostIsActive(host, at) {
  return at >= host.startHour && at < host.endHour;
}

function observedSnapshot(history, observationStep, sourceStep, scenario, random, previous) {
  if (scenario.blackout?.fromStep <= observationStep && observationStep < scenario.blackout?.toStep) {
    return { ...previous, at: observationStep * scenario.dtHours };
  }
  if (random.bool(scenario.pollLoss ?? 0)) return { ...previous, at: observationStep * scenario.dtHours };
  const sample = history[Math.max(0, sourceStep)] ?? history[0];
  let used = sample.used;
  const quantum = scenario.meterQuantum;
  if (quantum > 0) {
    if (scenario.meterMode === "floor") used = Math.floor(used / quantum) * quantum;
    else used = Math.round(used / quantum) * quantum;
  }
  if (scenario.meterNoise) used += random.normal() * scenario.meterNoise;
  if (sample.epoch === previous.epoch) used = Math.max(previous.used, used);
  return { at: observationStep * scenario.dtHours, used: Math.max(0, used), epoch: sample.epoch };
}

function hadamard(order) {
  let matrix = [[1]];
  while (matrix.length < order) {
    matrix = [
      ...matrix.map((row) => [...row, ...row]),
      ...matrix.map((row) => [...row, ...row.map((value) => -value)]),
    ];
  }
  return matrix;
}

class Host {
  constructor(index, scenario, seed) {
    this.index = index;
    this.random = new Random(seed);
    this.instrumentRandom = new Random(BigInt(seed) ^ 0xd1b54a32d192ed03n);
    this.instrumentBlock = null;
    this.instrumentBlockIndex = -1;
    this.startHour = scenario.arrivals?.[index] ?? 0;
    this.endHour = scenario.departures?.[index] ?? Number.POSITIVE_INFINITY;
    this.scale = scenario.initialScale;
    this.observations = [];
    this.previousSnapshot = { at: 0, used: 0, epoch: 0 };
    this.demandState = { burstRemaining: 0, burstMagnitude: 1 };
    this.z = [];
    this.x = [];
    this.trueBurn = [];
    this.predictedBurn = [];
    this.desiredUtility = 0;
    this.servedUtility = 0;
    this.controlUpdates = 0;
    this.unconfirmedLocalBurn = 0;
    this.sensorInconsistent = false;
  }

  observe(snapshot, currentHour, scenario) {
    if (snapshot.epoch !== this.previousSnapshot.epoch || snapshot.used > this.previousSnapshot.used + 1e-9) {
      this.unconfirmedLocalBurn = 0;
    }
    this.previousSnapshot = snapshot;
    if (!this.observations.length || snapshot.at !== this.observations.at(-1).at || snapshot.epoch !== this.observations.at(-1).epoch) {
      this.observations.push(snapshot);
    }
    const minimumAt = currentHour - scenario.slopeWindowHours * 2;
    while (this.observations.length > 2 && this.observations[1].at < minimumAt) this.observations.shift();
  }

  globalRate(currentHour, scenario) {
    const epoch = this.previousSnapshot.epoch;
    const points = this.observations.filter((point) => point.epoch === epoch && point.at >= currentHour - scenario.slopeWindowHours);
    const slope = linearSlope(points);
    return slope === null ? null : Math.max(0, slope);
  }

  updateControl(step, currentHour, scenario) {
    if (step % scenario.controlEverySteps !== 0) return;
    this.controlUpdates++;
    if (this.unconfirmedLocalBurn >= scenario.consistencyLimitPercent) {
      this.scale = 0;
      this.sensorInconsistent = true;
      return;
    }
    const globalRate = this.globalRate(currentHour, scenario);
    if (globalRate === null || this.observations.length < scenario.minimumSlopePoints) {
      this.scale = Math.max(scenario.minimumScale, this.scale * scenario.blindDecay);
      return;
    }
    const resetHour = (this.previousSnapshot.epoch + 1) * scenario.windowHours;
    const remainingHours = Math.max(scenario.dtHours, resetHour - currentHour);
    const latencyReserve = globalRate * scenario.safetyDelayHours;
    const available = scenario.targetPercent - this.previousSnapshot.used - latencyReserve;
    const sustainableRate = Math.max(0, available / remainingHours);
    if (sustainableRate <= 0) {
      this.scale = 0;
      return;
    }
    if (globalRate <= scenario.rateFloor) {
      this.scale = Math.min(1, this.scale + scenario.additiveRamp);
      return;
    }
    const ratio = clamp(sustainableRate / globalRate, scenario.minimumRatio, scenario.maximumRatio);
    this.scale = clamp(this.scale * Math.exp(scenario.controlGain * Math.log(ratio)), 0, 1);
  }

  instrumentSigns(step, modelCount) {
    const order = 2 ** Math.ceil(Math.log2(modelCount + 1));
    const blockIndex = Math.floor(step / order);
    if (blockIndex !== this.instrumentBlockIndex) {
      const matrix = hadamard(order).map((row) => row.slice(1, modelCount + 1));
      for (let index = matrix.length - 1; index > 0; index--) {
        const other = this.instrumentRandom.integer(index + 1);
        [matrix[index], matrix[other]] = [matrix[other], matrix[index]];
      }
      const columnSigns = Array.from({ length: modelCount }, () => this.instrumentRandom.bool() ? 1 : -1);
      this.instrumentBlock = matrix.map((row) => row.map((value, model) => value * columnSigns[model]));
      this.instrumentBlockIndex = blockIndex;
    }
    return this.instrumentBlock[step % order];
  }

  activity(step, currentHour, scenario, costs) {
    const active = hostIsActive(this, currentHour);
    const sharedMultiplier = demandMultiplier(scenario.demandKind, currentHour, this.index, this.random, this.demandState);
    const demand = scenario.baseDemand.map((base, model) => {
      if (!active) return 0;
      const heterogeneity = 1 + scenario.hostHeterogeneity * Math.sin((this.index + 1) * (model + 2) * 1.618);
      return Math.max(0, base * sharedMultiplier * heterogeneity);
    });
    const privateSigns = this.instrumentSigns(step, demand.length);
    const signs = demand.map((_value, model) => {
      if (scenario.instrumentFailure === "identical") return ((step + model * 17) & 1) ? 1 : -1;
      if (scenario.instrumentFailure === "anti-mimic" && this.index > 0) return -scenario.sharedInstrument[step]?.[model] || -1;
      return privateSigns[model];
    });
    if (this.index === 0) scenario.sharedInstrument[step] = signs;
    const excitation = scenario.excitation;
    const activity = demand.map((value, model) => value * this.scale * Math.max(0, 1 + excitation * signs[model]));
    const burn = activity.reduce((sum, value, model) => sum + value * costs[model], 0);
    this.z[step] = signs;
    this.x[step] = activity;
    this.trueBurn[step] = burn;
    this.unconfirmedLocalBurn += burn * scenario.dtHours;
    this.desiredUtility += demand.reduce((sum, value) => sum + value, 0) * scenario.dtHours;
    this.servedUtility += activity.reduce((sum, value) => sum + value, 0) * scenario.dtHours;
    return { activity, burn };
  }
}

function defaultScenario(overrides) {
  const dtMinutes = overrides.dtMinutes ?? 5;
  const dtHours = dtMinutes / 60;
  return {
    name: "unnamed",
    seed: 1,
    hosts: 2,
    durationHours: 168,
    windowHours: 168,
    dtMinutes,
    dtHours,
    modelNames: ["sol:xhigh", "luna:max"],
    modelCosts: [0.58244, 0.02508],
    baseDemand: [0.65, 8],
    hostHeterogeneity: 0.15,
    demandKind: "constant",
    arrivals: [],
    departures: [],
    initialScale: 0.08,
    minimumScale: 0.001,
    blindDecay: 0.94,
    excitation: 0.35,
    meterQuantum: 1,
    meterMode: "round",
    meterNoise: 0,
    reportingDelayMinutes: 10,
    reportingJitterMinutes: 0,
    pollLoss: 0,
    targetPercent: 92,
    slopeWindowHours: 2,
    safetyDelayHours: 0.5,
    consistencyLimitPercent: 2,
    minimumSlopePoints: 4,
    controlEveryMinutes: 20,
    controlEverySteps: Math.max(1, Math.round(20 / dtMinutes)),
    controlGain: 0.18,
    additiveRamp: 0.01,
    minimumRatio: 0.25,
    maximumRatio: 2,
    rateFloor: 0.01,
    estimatorMaxLagHours: 1,
    estimatorWarmupHours: 12,
    estimatorFoldHours: 24,
    costDrift: null,
    blackout: null,
    instrumentFailure: null,
    foreignBurn: null,
    populationMultiplier: 1,
    sharedInstrument: [],
    ...overrides,
    dtHours,
    controlEverySteps: Math.max(1, Math.round((overrides.controlEveryMinutes ?? 20) / dtMinutes)),
    sharedInstrument: [],
  };
}

function estimateCosts(host, meter, scenario) {
  const modelCount = scenario.modelCosts.length;
  const startStep = Math.ceil(scenario.estimatorWarmupHours / scenario.dtHours);
  const maxLag = Math.max(1, Math.ceil(scenario.estimatorMaxLagHours / scenario.dtHours));
  const foldHours = scenario.estimatorFoldHours;
  const foldOf = (step) => Math.floor(step * scenario.dtHours / foldHours) % 2;
  const denominators = Array.from({ length: 2 }, () => Array(modelCount).fill(0));
  const samples = Array(modelCount).fill(0);
  for (let step = startStep; step < host.x.length; step++) {
    if (!host.x[step] || !host.z[step]) continue;
    const fold = foldOf(step);
    for (let model = 0; model < modelCount; model++) {
      denominators[fold][model] += host.z[step][model] * host.x[step][model];
      samples[model]++;
    }
  }

  const lagMoments = Array.from({ length: 2 }, () =>
    Array.from({ length: maxLag + 1 }, () => Array(modelCount).fill(0)));
  for (let step = Math.max(1, startStep); step < meter.length; step++) {
    const current = meter[step];
    const previous = meter[step - 1];
    if (!current || !previous || current.epoch !== previous.epoch) continue;
    const delta = current.used - previous.used;
    if (delta < -1e-9) continue;
    const observedRate = delta / scenario.dtHours;
    for (let lag = 1; lag <= maxLag; lag++) {
      const source = step - lag;
      if (source < startStep || !host.z[source]) continue;
      const fold = foldOf(source);
      for (let model = 0; model < modelCount; model++) {
        lagMoments[fold][lag][model] += host.z[source][model] * observedRate;
      }
    }
  }

  const estimates = Array(modelCount).fill(Number.NaN);
  const selectedLags = Array.from({ length: modelCount }, () => []);
  const numerator = Array(modelCount).fill(0);
  const denominator = Array(modelCount).fill(0);
  for (let model = 0; model < modelCount; model++) {
    const crossFit = [];
    for (let selectionFold = 0; selectionFold < 2; selectionFold++) {
      const estimationFold = 1 - selectionFold;
      if (denominators[estimationFold][model] <= 1e-9) continue;
      const candidates = [];
      for (let lag = 1; lag <= maxLag; lag++) {
        candidates.push({ lag, moment: lagMoments[selectionFold][lag][model] });
      }
      const selected = candidates.sort((left, right) => right.moment - left.moment)[0];
      const estimate = lagMoments[estimationFold][selected.lag][model] / denominators[estimationFold][model];
      if (Number.isFinite(estimate)) crossFit.push(Math.max(0, estimate));
      selectedLags[model].push(selected.lag);
    }
    if (crossFit.length) estimates[model] = mean(crossFit);
    numerator[model] = lagMoments[0][selectedLags[model][1] ?? 1][model] +
      lagMoments[1][selectedLags[model][0] ?? 1][model];
    denominator[model] = denominators[0][model] + denominators[1][model];
  }
  return { estimates, numerator, denominator, samples, selectedLags, lagMoments };
}

function summarizeWindows(history, scenario) {
  const windows = [];
  let currentEpoch = history[0]?.epoch ?? 0;
  let peak = 0;
  let exhaustedAt = null;
  for (let step = 0; step < history.length; step++) {
    const point = history[step];
    if (point.epoch !== currentEpoch) {
      windows.push({ epoch: currentEpoch, used: peak, exhaustedAt });
      currentEpoch = point.epoch;
      peak = 0;
      exhaustedAt = null;
    }
    peak = Math.max(peak, point.used);
    if (exhaustedAt === null && point.used >= 100) exhaustedAt = step * scenario.dtHours - currentEpoch * scenario.windowHours;
  }
  windows.push({ epoch: currentEpoch, used: peak, exhaustedAt });
  return windows;
}

export function runScenario(rawScenario) {
  const scenario = defaultScenario(rawScenario);
  const steps = Math.ceil(scenario.durationHours / scenario.dtHours);
  const hosts = Array.from({ length: scenario.hosts }, (_, index) =>
    new Host(index, scenario, BigInt(scenario.seed) * 1_000_003n + BigInt(index + 1) * 97_409n));
  const meterRandom = new Random(BigInt(scenario.seed) * 31n + 17n);
  const trueHistory = [{ used: 0, epoch: 0 }];
  const observedByHost = hosts.map(() => []);
  let epoch = 0;
  let used = 0;
  let totalForeignBurn = 0;
  const globalRate = [];
  const localRates = hosts.map(() => []);

  for (let step = 0; step < steps; step++) {
    const currentHour = step * scenario.dtHours;
    const nextEpoch = Math.floor(currentHour / scenario.windowHours);
    if (nextEpoch !== epoch) {
      epoch = nextEpoch;
      used = 0;
    }

    for (const host of hosts) {
      const jitterSteps = scenario.reportingJitterMinutes > 0
        ? Math.round((meterRandom.next() * 2 - 1) * scenario.reportingJitterMinutes / scenario.dtMinutes)
        : 0;
      const delaySteps = Math.max(0, Math.round(scenario.reportingDelayMinutes / scenario.dtMinutes) + jitterSteps);
      const sourceStep = Math.max(0, step - delaySteps);
      const snapshot = observedSnapshot(trueHistory, step, sourceStep, scenario, host.random, host.previousSnapshot);
      host.observe(snapshot, currentHour, scenario);
      observedByHost[host.index][step] = snapshot;
      host.updateControl(step, currentHour, scenario);
    }

    const costs = modelCostsAt(scenario, currentHour);
    let burnRate = 0;
    for (const host of hosts) {
      const activity = host.activity(step, currentHour, scenario, costs);
      burnRate += activity.burn * scenario.populationMultiplier;
      localRates[host.index][step] = activity.burn;
    }
    if (scenario.foreignBurn) {
      const foreign = Math.max(0, scenario.foreignBurn(currentHour, step, scenario));
      burnRate += foreign;
      totalForeignBurn += foreign * scenario.dtHours;
    }
    globalRate[step] = burnRate;
    used += burnRate * scenario.dtHours;
    trueHistory[step + 1] = { used, epoch };
  }

  const windows = summarizeWindows(trueHistory, scenario);
  const estimates = hosts.map((host) => estimateCosts(host, observedByHost[host.index], scenario));
  const relativeErrors = estimates.flatMap((estimate) => estimate.estimates.map((value, model) =>
    Number.isFinite(value) ? Math.abs(value - scenario.modelCosts[model]) / scenario.modelCosts[model] : Number.POSITIVE_INFINITY));
  const attributionErrors = hosts.map((host, hostIndex) => {
    const estimate = estimates[hostIndex].estimates;
    let trueTotal = 0;
    let predictedTotal = 0;
    for (let step = Math.ceil(scenario.estimatorWarmupHours / scenario.dtHours); step < host.x.length; step++) {
      if (!host.x[step]) continue;
      const actualCosts = modelCostsAt(scenario, step * scenario.dtHours);
      trueTotal += host.x[step].reduce((sum, value, model) => sum + value * actualCosts[model], 0);
      predictedTotal += host.x[step].reduce((sum, value, model) => sum + value * (Number.isFinite(estimate[model]) ? estimate[model] : 0), 0);
    }
    return trueTotal > 0 ? Math.abs(predictedTotal - trueTotal) / trueTotal : Number.POSITIVE_INFINITY;
  });
  const servedFractions = hosts
    .filter((host) => host.desiredUtility > 0)
    .map((host) => host.servedUtility / host.desiredUtility);
  const completeWindows = windows.filter((window) => window.epoch < Math.floor((scenario.durationHours - scenario.dtHours) / scenario.windowHours));
  const evaluatedWindows = completeWindows.length ? completeWindows : windows;
  const exhausted = evaluatedWindows.some((window) => window.exhaustedAt !== null && window.exhaustedAt < scenario.windowHours - scenario.dtHours);
  const meanUsed = mean(evaluatedWindows.map((window) => Math.min(100, window.used)));
  const overshoot = Math.max(0, ...evaluatedWindows.map((window) => window.used - scenario.targetPercent));
  const tailStart = Math.floor(steps * 0.5);
  const targetRate = scenario.targetPercent / scenario.windowHours;
  const trackingError = mean(globalRate.slice(tailStart).map((rate) => Math.abs(rate - targetRate))) / Math.max(targetRate, 1e-9);
  let maxPaceLead = 0;
  for (let step = 0; step < trueHistory.length; step++) {
    const point = trueHistory[step];
    const elapsed = Math.max(0, step * scenario.dtHours - point.epoch * scenario.windowHours);
    const ideal = scenario.targetPercent * Math.min(1, elapsed / scenario.windowHours);
    maxPaceLead = Math.max(maxPaceLead, point.used - ideal);
  }

  return {
    scenario,
    windows,
    exhausted,
    meanUsed,
    overshoot,
    trackingError,
    maxPaceLead,
    servedFraction: mean(servedFractions),
    fairness: jain(servedFractions),
    costEstimates: estimates.map((estimate) => estimate.estimates),
    medianCostRelativeError: median(relativeErrors),
    p90CostRelativeError: percentile(relativeErrors, 0.9),
    medianAttributionRelativeError: median(attributionErrors),
    p90AttributionRelativeError: percentile(attributionErrors, 0.9),
    totalForeignBurn,
    hosts: hosts.map((host) => ({
      startHour: host.startHour,
      endHour: host.endHour,
      servedFraction: host.desiredUtility > 0 ? host.servedUtility / host.desiredUtility : 0,
      finalScale: host.scale,
      sensorInconsistent: host.sensorInconsistent,
    })),
  };
}

function balancedSigns(accountCount, random) {
  const signs = Array.from({ length: accountCount }, (_, index) => index < Math.floor(accountCount / 2) ? 1 : -1);
  if (accountCount % 2) signs[signs.length - 1] = 0;
  for (let index = signs.length - 1; index > 0; index--) {
    const other = random.integer(index + 1);
    [signs[index], signs[other]] = [signs[other], signs[index]];
  }
  return signs;
}

export function runRoutingCalibration(raw = {}) {
  const config = {
    name: "routing calibration",
    seed: 1,
    hosts: 2,
    accounts: 12,
    modelCosts: [0.58244, 0.02508],
    modelMix: [0.65, 8],
    durationHours: 168,
    windowHours: 168,
    dtMinutes: 5,
    meterQuantum: 1,
    excitation: 0.9,
    targetLoad: 0.9,
    reportingDelayMinutes: 0,
    estimatorMaxDelayMinutes: 30,
    instrumentFailure: null,
    hiddenBurnPerHour: 0,
    hiddenBurnMode: "uniform",
    costDrift: null,
    ...raw,
  };
  const dtHours = config.dtMinutes / 60;
  const steps = Math.ceil(config.durationHours / dtHours);
  const delaySteps = Math.max(0, Math.round(config.reportingDelayMinutes / config.dtMinutes));
  const randoms = Array.from({ length: config.hosts }, (_, host) =>
    new Random(BigInt(config.seed) * 1_000_003n + BigInt(host + 1) * 65_537n));
  const baseBurn = config.modelMix.reduce((sum, value, model) => sum + value * config.modelCosts[model], 0);
  const targetRate = config.accounts * 100 / config.windowHours * config.targetLoad;
  const activityScale = targetRate / Math.max(1e-12, config.hosts * baseBurn);
  const demand = config.modelMix.map((value) => value * activityScale);
  const trueHistory = [{ epoch: 0, used: Array(config.accounts).fill(0) }];
  const instruments = Array.from({ length: config.hosts }, () => []);
  const activities = Array.from({ length: config.hosts }, () => []);
  const observed = [];
  let previousObserved = Array(config.accounts).fill(0);
  let previousObservedEpoch = 0;
  let epoch = 0;
  let used = Array(config.accounts).fill(0);
  let firstHostSigns = null;

  for (let step = 0; step < steps; step++) {
    const currentHour = step * dtHours;
    const nextEpoch = Math.floor(currentHour / config.windowHours);
    if (nextEpoch !== epoch) {
      epoch = nextEpoch;
      used = Array(config.accounts).fill(0);
    }
    const costs = [...config.modelCosts];
    if (config.costDrift && currentHour >= config.costDrift.atHour) {
      for (let model = 0; model < costs.length; model++) costs[model] *= config.costDrift.multipliers[model] ?? 1;
    }
    const accountRate = Array(config.accounts).fill(0);
    for (let host = 0; host < config.hosts; host++) {
      const z = Array.from({ length: config.accounts }, () => Array(costs.length).fill(0));
      const x = Array.from({ length: config.accounts }, () => Array(costs.length).fill(0));
      const availableAccounts = config.hostAccountSets?.[host] ?? Array.from({ length: config.accounts }, (_, account) => account);
      for (let model = 0; model < costs.length; model++) {
        let signs;
        if (config.instrumentFailure === "identical" && host > 0) {
          signs = firstHostSigns.map((row) => row[model]);
        } else if (config.instrumentFailure === "anti-mimic" && host > 0) {
          signs = firstHostSigns.map((row) => -row[model]);
        } else {
          const availableSigns = balancedSigns(availableAccounts.length, randoms[host]);
          signs = Array(config.accounts).fill(0);
          availableAccounts.forEach((account, index) => { signs[account] = availableSigns[index]; });
        }
        for (const account of availableAccounts) {
          z[account][model] = signs[account];
          x[account][model] = demand[model] / availableAccounts.length * Math.max(0, 1 + config.excitation * signs[account]);
          accountRate[account] += x[account][model] * costs[model];
        }
      }
      if (host === 0) firstHostSigns = z;
      instruments[host][step] = z;
      activities[host][step] = x;
    }
    if (config.hiddenBurnPerHour > 0) {
      if (config.hiddenBurnMode === "mimic-first") {
        for (let account = 0; account < config.accounts; account++) {
          const sign = firstHostSigns[account][0];
          accountRate[account] += config.hiddenBurnPerHour / config.accounts * Math.max(0, 1 + 0.9 * sign);
        }
      } else {
        for (let account = 0; account < config.accounts; account++) accountRate[account] += config.hiddenBurnPerHour / config.accounts;
      }
    }
    used = used.map((value, account) => value + accountRate[account] * dtHours);
    trueHistory[step + 1] = { epoch, used: [...used] };

    const source = trueHistory[Math.max(0, step + 1 - delaySteps)];
    let snapshot = source.used.map((value) => config.meterQuantum > 0
      ? Math.floor(value / config.meterQuantum) * config.meterQuantum
      : value);
    if (source.epoch === previousObservedEpoch) {
      snapshot = snapshot.map((value, account) => Math.max(previousObserved[account], value));
    }
    observed[step] = { epoch: source.epoch, used: snapshot };
    previousObserved = snapshot;
    previousObservedEpoch = source.epoch;
  }

  const estimates = [];
  const selectedDelaysByHost = [];
  const attributionErrors = [];
  const maxEstimatorDelaySteps = Math.max(0, Math.round(config.estimatorMaxDelayMinutes / config.dtMinutes));
  for (let host = 0; host < config.hosts; host++) {
    const numerator = Array(config.modelCosts.length).fill(0);
    const denominator = Array(config.modelCosts.length).fill(0);
    const selectedDelays = Array(config.modelCosts.length).fill(0);
    for (let model = 0; model < config.modelCosts.length; model++) {
      const candidates = [];
      for (let lag = 0; lag <= maxEstimatorDelaySteps; lag++) {
        let lagNumerator = 0;
        let lagDenominator = 0;
        for (let step = 1; step < steps; step++) {
          if (observed[step].epoch !== observed[step - 1].epoch) continue;
          const sourceStep = step - lag;
          if (sourceStep < 0) continue;
          for (let account = 0; account < config.accounts; account++) {
            const observedRate = (observed[step].used[account] - observed[step - 1].used[account]) / dtHours;
            const z = instruments[host][sourceStep][account][model];
            lagNumerator += z * observedRate;
            lagDenominator += z * activities[host][sourceStep][account][model];
          }
        }
        candidates.push({ lag, numerator: lagNumerator, denominator: lagDenominator });
      }
      const selected = candidates.sort((left, right) => right.numerator - left.numerator)[0];
      numerator[model] = selected.numerator;
      denominator[model] = selected.denominator;
      selectedDelays[model] = selected.lag;
    }
    const estimate = numerator.map((value, model) => denominator[model] > 1e-12
      ? Math.max(0, value / denominator[model])
      : Number.NaN);
    estimates[host] = estimate;
    selectedDelaysByHost[host] = selectedDelays.map((steps) => steps * config.dtMinutes);
    const actualCosts = config.costDrift ? config.modelCosts.map((value, model) =>
      value * (config.costDrift.multipliers[model] ?? 1)) : config.modelCosts;
    const trueRate = demand.reduce((sum, value, model) => sum + value * actualCosts[model], 0);
    const predictedRate = demand.reduce((sum, value, model) => sum + value * estimate[model], 0);
    attributionErrors[host] = Math.abs(predictedRate - trueRate) / trueRate;
  }
  const coefficientErrors = estimates.flatMap((estimate) => estimate.map((value, model) => {
    const target = config.costDrift ? config.modelCosts[model] * (config.costDrift.multipliers[model] ?? 1) : config.modelCosts[model];
    return Math.abs(value - target) / target;
  }));
  return {
    config,
    estimates,
    selectedDelayMinutes: selectedDelaysByHost,
    medianCoefficientError: median(coefficientErrors),
    p90CoefficientError: percentile(coefficientErrors, 0.9),
    medianAttributionError: median(attributionErrors),
    p90AttributionError: percentile(attributionErrors, 0.9),
    debug: config.debug ? { observed, instruments, activities } : undefined,
  };
}

export function anthropicWeeklyMeters(opusUsage, fableUsage, weeklyCapacityWeight = 1) {
  const sharedCapacity = 100 * weeklyCapacityWeight;
  const fableCapacity = sharedCapacity / 2;
  return {
    sharedPercent: 100 * (opusUsage + fableUsage) / sharedCapacity,
    fablePercent: 100 * fableUsage / fableCapacity,
  };
}

export function runAnthropicScenario(raw = {}) {
  const config = {
    name: "Anthropic coupled meters",
    seed: 201,
    hosts: 2,
    durationHours: 168,
    dtMinutes: 5,
    accountWeights: [2, 1, 2],
    fiveHourCapacityPerWeight: 18,
    opusDemandPerHost: 1.2,
    fableRate: (hour) => 0.22 * (0.4 + 0.6 * (1 + Math.sin(hour * 0.37)) / 2),
    targetPercent: 92,
    initialShare: 0.08,
    controlGain: 0.18,
    additiveRamp: 0.01,
    ...raw,
  };
  const dtHours = config.dtMinutes / 60;
  const steps = Math.ceil(config.durationHours / dtHours);
  const random = new Random(config.seed);
  const accounts = config.accountWeights.map((weight) => ({
    weight,
    sharedCapacity: 100 * weight,
    fableCapacity: 50 * weight,
    fiveCapacity: config.fiveHourCapacityPerWeight * weight,
    sharedUsed: 0,
    fableUsed: 0,
    fiveUsed: 0,
  }));
  const shares = Array(config.hosts).fill(config.initialShare);
  let previousTotalShared = 0;
  let previousTotalFive = 0;
  let maxFivePercent = 0;
  let maxSharedPercent = 0;
  let maxFablePercent = 0;
  let minimumReserve = Number.POSITIVE_INFINITY;
  let rejectedOpus = 0;

  for (let step = 0; step < steps; step++) {
    const hour = step * dtHours;
    if (step > 0 && Math.floor(hour / 5) !== Math.floor((hour - dtHours) / 5)) {
      for (const account of accounts) account.fiveUsed = 0;
      previousTotalFive = 0;
    }
    if (step > 0 && Math.floor(hour / 168) !== Math.floor((hour - dtHours) / 168)) {
      for (const account of accounts) {
        account.sharedUsed = 0;
        account.fableUsed = 0;
      }
      previousTotalShared = 0;
    }

    const totalShared = accounts.reduce((sum, account) => sum + account.sharedUsed, 0);
    const totalFive = accounts.reduce((sum, account) => sum + account.fiveUsed, 0);
    const observedRate = Math.max(0, Math.max(
      (totalShared - previousTotalShared) / dtHours,
      (totalFive - previousTotalFive) / dtHours,
    ));
    previousTotalShared = totalShared;
    previousTotalFive = totalFive;
    const fiveReset = Math.max(dtHours, (Math.floor(hour / 5) + 1) * 5 - hour);
    const weeklyReset = Math.max(dtHours, (Math.floor(hour / 168) + 1) * 168 - hour);
    const sustainableFive = accounts.reduce((sum, account) =>
      sum + Math.max(0, config.targetPercent / 100 * account.fiveCapacity - account.fiveUsed) / fiveReset, 0);
    const sustainableWeekly = accounts.reduce((sum, account) => {
      const reservedForFable = Math.max(0, account.fableCapacity - account.fableUsed);
      const targetShared = config.targetPercent / 100 * account.sharedCapacity;
      return sum + Math.max(0, targetShared - account.sharedUsed - reservedForFable) / weeklyReset;
    }, 0);
    const sustainable = Math.min(sustainableFive, sustainableWeekly);
    if (step % Math.max(1, Math.round(20 / config.dtMinutes)) === 0) {
      for (let host = 0; host < shares.length; host++) {
        if (observedRate <= 1e-9) shares[host] = Math.min(1, shares[host] + config.additiveRamp);
        else {
          const ratio = clamp(sustainable / observedRate, 0.25, 2);
          shares[host] = clamp(shares[host] * Math.exp(config.controlGain * Math.log(ratio)), 0, 1);
        }
      }
    }

    const fableBurn = Math.max(0, config.fableRate(hour, step)) * dtHours;
    let fableRemaining = fableBurn;
    for (const account of [...accounts].sort((left, right) =>
      left.fableUsed / left.fableCapacity - right.fableUsed / right.fableCapacity)) {
      const room = Math.min(account.fableCapacity - account.fableUsed, account.sharedCapacity - account.sharedUsed, account.fiveCapacity - account.fiveUsed);
      const admitted = Math.max(0, Math.min(fableRemaining, room));
      account.fableUsed += admitted;
      account.sharedUsed += admitted;
      account.fiveUsed += admitted;
      fableRemaining -= admitted;
    }

    const planned = accounts.map(() => 0);
    for (let host = 0; host < config.hosts; host++) {
      const desired = config.opusDemandPerHost * (0.85 + 0.3 * random.next()) * shares[host];
      const selected = accounts
        .map((account, index) => ({
          index,
          pressure: (account.sharedUsed + planned[index] * dtHours) / account.sharedCapacity,
          weeklyRoom: account.sharedCapacity - account.sharedUsed - (account.fableCapacity - account.fableUsed),
          fiveRoom: account.fiveCapacity - account.fiveUsed,
        }))
        .filter((item) => item.weeklyRoom > 0 && item.fiveRoom > 0)
        .sort((left, right) => left.pressure - right.pressure)[0];
      if (!selected) {
        rejectedOpus += desired * dtHours;
        continue;
      }
      planned[selected.index] += desired;
    }
    for (let index = 0; index < accounts.length; index++) {
      const account = accounts[index];
      const reserve = account.sharedCapacity - account.sharedUsed - (account.fableCapacity - account.fableUsed);
      const admitted = Math.max(0, Math.min(planned[index] * dtHours, reserve, account.fiveCapacity - account.fiveUsed));
      rejectedOpus += planned[index] * dtHours - admitted;
      account.sharedUsed += admitted;
      account.fiveUsed += admitted;
    }

    for (const account of accounts) {
      const meters = anthropicWeeklyMeters(account.sharedUsed - account.fableUsed, account.fableUsed, account.weight);
      maxFivePercent = Math.max(maxFivePercent, 100 * account.fiveUsed / account.fiveCapacity);
      maxSharedPercent = Math.max(maxSharedPercent, meters.sharedPercent);
      maxFablePercent = Math.max(maxFablePercent, meters.fablePercent);
      minimumReserve = Math.min(minimumReserve,
        account.sharedCapacity - account.sharedUsed - (account.fableCapacity - account.fableUsed));
    }
  }

  return {
    config,
    maxFivePercent,
    maxSharedPercent,
    maxFablePercent,
    minimumReserve,
    rejectedOpus,
    finalShares: shares,
    safe: maxFivePercent <= 100 + 1e-9 && maxSharedPercent <= 100 + 1e-9 &&
      maxFablePercent <= 100 + 1e-9 && minimumReserve >= -1e-9,
  };
}

export const ANTHROPIC_SCENARIOS = [
  { name: "A1 two hosts, three tier-weighted accounts", seed: 201 },
  { name: "A2 bursty interactive Fable pressure", seed: 202, fableRate: (hour) => Math.sin(hour * 1.9) > 0.72 ? 1.8 : 0.04 },
  { name: "A3 twenty autonomous hosts", seed: 203, hosts: 20, initialShare: 0.02, opusDemandPerHost: 0.8 },
];

export const SCENARIOS = [
  {
    name: "01 exact meter, two steady hosts",
    seed: 11,
    hosts: 2,
    meterQuantum: 0,
    reportingDelayMinutes: 0,
    excitation: 0.2,
  },
  {
    name: "02 integer meter, two diurnal hosts",
    seed: 12,
    hosts: 2,
    demandKind: "diurnal",
    meterQuantum: 1,
    reportingDelayMinutes: 10,
    excitation: 0.35,
  },
  {
    name: "03 twenty heterogeneous hosts",
    seed: 13,
    hosts: 20,
    demandKind: "diurnal",
    meterQuantum: 1,
    reportingDelayMinutes: 10,
    excitation: 0.45,
    initialScale: 0.025,
    durationHours: 336,
  },
  {
    name: "04 arrivals, departures, and correlated bursts",
    seed: 14,
    hosts: 12,
    arrivals: [0, 0, 0, 12, 12, 24, 36, 48, 72, 96, 110, 130],
    departures: [336, 100, 220, 336, 190, 300, 336, 250, 336, 280, 336, 336],
    demandKind: "correlated-bursty",
    durationHours: 336,
    meterQuantum: 1,
    reportingDelayMinutes: 15,
    reportingJitterMinutes: 5,
    pollLoss: 0.05,
    excitation: 0.5,
    initialScale: 0.025,
    safetyDelayHours: 1,
    estimatorMaxLagHours: 2,
  },
  {
    name: "05 model cost doubles mid-window",
    seed: 15,
    hosts: 8,
    durationHours: 336,
    demandKind: "diurnal",
    meterQuantum: 1,
    reportingDelayMinutes: 15,
    excitation: 0.5,
    initialScale: 0.035,
    costDrift: { atHour: 84, durationHours: 12, multipliers: [2, 1.5] },
  },
  {
    name: "06 severe polling loss and six-hour blackout",
    seed: 16,
    hosts: 8,
    durationHours: 336,
    demandKind: "bursty",
    meterQuantum: 1,
    reportingDelayMinutes: 20,
    reportingJitterMinutes: 10,
    pollLoss: 0.35,
    blackout: { fromStep: Math.round(70 * 60 / 5), toStep: Math.round(76 * 60 / 5) },
    excitation: 0.55,
    initialScale: 0.025,
    blindDecay: 0.85,
    safetyDelayHours: 2,
    estimatorMaxLagHours: 8,
  },
  {
    name: "07 one hundred simultaneous cold starts",
    seed: 17,
    hosts: 100,
    durationHours: 168,
    demandKind: "constant",
    meterQuantum: 1,
    reportingDelayMinutes: 15,
    excitation: 0.6,
    initialScale: 0.003,
    safetyDelayHours: 2,
  },
  {
    name: "08 hidden workload independent of instruments",
    seed: 18,
    hosts: 10,
    durationHours: 336,
    demandKind: "diurnal",
    meterQuantum: 1,
    reportingDelayMinutes: 10,
    excitation: 0.55,
    initialScale: 0.02,
    foreignBurn: (hour) => 0.12 + 0.08 * (1 + Math.sin(hour * 0.71)) / 2,
  },
  {
    name: "09 foreign workload tracks aggregate demand",
    seed: 19,
    hosts: 10,
    durationHours: 336,
    demandKind: "correlated-bursty",
    meterQuantum: 1,
    reportingDelayMinutes: 10,
    excitation: 0.55,
    initialScale: 0.02,
    foreignBurn: (hour) => (Math.sin(hour * 1.71) > 0.7 ? 0.8 : 0.03),
    safetyDelayHours: 1.5,
  },
  {
    name: "10 instruments accidentally identical",
    seed: 20,
    hosts: 20,
    durationHours: 336,
    demandKind: "diurnal",
    meterQuantum: 1,
    reportingDelayMinutes: 10,
    excitation: 0.5,
    initialScale: 0.02,
    instrumentFailure: "identical",
  },
  {
    name: "11 adversary anti-mimics the first host instrument",
    seed: 21,
    hosts: 2,
    durationHours: 336,
    demandKind: "constant",
    meterQuantum: 0.25,
    reportingDelayMinutes: 5,
    excitation: 0.6,
    instrumentFailure: "anti-mimic",
    initialScale: 0.05,
  },
  {
    name: "12 frozen meter trips local consistency circuit",
    seed: 22,
    hosts: 20,
    durationHours: 168,
    demandKind: "constant",
    meterQuantum: 100,
    meterMode: "floor",
    reportingDelayMinutes: 360,
    excitation: 0.6,
    initialScale: 0.02,
    blindDecay: 0.995,
    safetyDelayHours: 8,
  },
  {
    name: "13 one thousand simultaneous high-demand hosts",
    seed: 23,
    hosts: 1000,
    durationHours: 168,
    windowHours: 168,
    demandKind: "constant",
    meterQuantum: 1,
    reportingDelayMinutes: 15,
    excitation: 0,
    initialScale: 0.02,
    blindDecay: 0.8,
    baseDemand: [3, 30],
    estimatorWarmupHours: 1,
  },
  {
    name: "14 unbounded-population first-pulse counterexample",
    seed: 24,
    hosts: 1000,
    populationMultiplier: 1000,
    durationHours: 1,
    windowHours: 168,
    demandKind: "constant",
    meterQuantum: 1,
    reportingDelayMinutes: 15,
    excitation: 0,
    initialScale: 0.02,
    blindDecay: 0.8,
    baseDemand: [3, 30],
    estimatorWarmupHours: 1,
  },
];

export const CALIBRATION_SCENARIOS = [
  { name: "C1 two hosts, exact account meters", seed: 101, hosts: 2, meterQuantum: 0 },
  { name: "C2 two hosts, twelve integer meters, one week", seed: 102, hosts: 2, meterQuantum: 1 },
  { name: "C3 two hosts, twelve integer meters, four weeks", seed: 103, hosts: 2, meterQuantum: 1, durationHours: 168 * 4 },
  { name: "C4 five hosts, four weeks", seed: 104, hosts: 5, meterQuantum: 1, durationHours: 168 * 4 },
  { name: "C5 twenty hosts, eight weeks", seed: 105, hosts: 20, meterQuantum: 1, durationHours: 168 * 8 },
  { name: "C6 two hosts, twenty-minute reporting delay", seed: 106, hosts: 2, meterQuantum: 1, durationHours: 168 * 4, reportingDelayMinutes: 20 },
  { name: "C7 independent hidden non-Pi workload", seed: 107, hosts: 2, meterQuantum: 1, durationHours: 168 * 4, hiddenBurnPerHour: 1 },
  { name: "C8 hidden workload copies this host's routing code", seed: 108, hosts: 2, meterQuantum: 1, durationHours: 168 * 4, hiddenBurnPerHour: 1, hiddenBurnMode: "mimic-first" },
  { name: "C9 every installation has a cloned machine ID", seed: 109, hosts: 5, meterQuantum: 1, durationHours: 168 * 4, instrumentFailure: "identical" },
  { name: "C10 adversary anti-mimics the first host", seed: 110, hosts: 2, meterQuantum: 1, durationHours: 168 * 4, instrumentFailure: "anti-mimic" },
  { name: "C11 model costs double after calibration starts", seed: 111, hosts: 2, meterQuantum: 1, durationHours: 168 * 4, costDrift: { atHour: 336, multipliers: [2, 2] } },
  { name: "C12 five-percent meters", seed: 112, hosts: 2, meterQuantum: 5, durationHours: 168 * 8 },
  { name: "C13 overlapping account subsets", seed: 113, hosts: 2, meterQuantum: 1, durationHours: 168 * 4, hostAccountSets: [Array.from({ length: 12 }, (_, account) => account), [0, 7, 8, 9, 10, 11]] },
];

function classification(result) {
  if (result.exhausted) return "UNSAFE";
  if (result.hosts.some((host) => host.sensorInconsistent)) return "SAFE, SENSOR FAIL-CLOSED";
  if (result.maxPaceLead > 10) return "SAFE, FRONT-LOADED";
  if (result.meanUsed < 65) return "SAFE, LOW UTILIZATION";
  if (result.p90AttributionRelativeError > 0.75) return "SAFE, ATTRIBUTION FAILED";
  if (result.p90AttributionRelativeError > 0.35) return "SAFE, WEAK ATTRIBUTION";
  return "WORKS";
}

function formatNumber(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "∞";
}

function calibrationClassification(result) {
  if (result.p90AttributionError <= 0.2) return "WORKS";
  if (result.p90AttributionError <= 0.5) return "USABLE WITH UCB";
  return "NOT IDENTIFIABLE";
}

export function markdownReport(results, calibrations = [], anthropicResults = []) {
  const lines = [
    "| Scenario | Result | Used | Quota overshoot | Max pace lead | Single-meter attribution p90 | Fairness |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const result of results) {
    lines.push(`| ${result.scenario.name} | ${classification(result)} | ${formatNumber(result.meanUsed)}% | ${formatNumber(result.overshoot)}pp | ${formatNumber(result.maxPaceLead)}pp | ${formatNumber(result.p90AttributionRelativeError * 100)}% | ${formatNumber(result.fairness, 3)} |`);
  }
  if (calibrations.length) {
    lines.push("", "| Calibration scenario | Result | Coefficient p90 error | Attribution p90 error |", "|---|---:|---:|---:|");
    for (const result of calibrations) {
      lines.push(`| ${result.config.name} | ${calibrationClassification(result)} | ${formatNumber(result.p90CoefficientError * 100)}% | ${formatNumber(result.p90AttributionError * 100)}% |`);
    }
  }
  if (anthropicResults.length) {
    lines.push("", "| Anthropic scenario | Result | Five-hour peak | Shared-weekly peak | Fable-weekly peak | Minimum reserved capacity |", "|---|---:|---:|---:|---:|---:|");
    for (const result of anthropicResults) {
      lines.push(`| ${result.config.name} | ${result.safe ? "WORKS" : "UNSAFE"} | ${formatNumber(result.maxFivePercent)}% | ${formatNumber(result.maxSharedPercent)}% | ${formatNumber(result.maxFablePercent)}% | ${formatNumber(result.minimumReserve, 2)} |`);
    }
  }
  return lines.join("\n");
}

async function main() {
  const selected = process.argv.slice(2);
  const scenarios = selected.length
    ? SCENARIOS.filter((scenario) => selected.some((term) => scenario.name.includes(term)))
    : SCENARIOS;
  const calibrationScenarios = selected.length
    ? CALIBRATION_SCENARIOS.filter((scenario) => selected.some((term) => scenario.name.includes(term)))
    : CALIBRATION_SCENARIOS;
  const anthropicScenarios = selected.length
    ? ANTHROPIC_SCENARIOS.filter((scenario) => selected.some((term) => scenario.name.includes(term)))
    : ANTHROPIC_SCENARIOS;
  if (!scenarios.length && !calibrationScenarios.length && !anthropicScenarios.length) {
    throw new Error(`no scenarios matched: ${selected.join(", ")}`);
  }
  const results = scenarios.map(runScenario);
  const calibrations = calibrationScenarios.map(runRoutingCalibration);
  const anthropicResults = anthropicScenarios.map(runAnthropicScenario);
  if (process.env.SIMULATOR_JSON === "1") console.log(JSON.stringify({ control: results, calibration: calibrations, anthropic: anthropicResults }, null, 2));
  else console.log(markdownReport(results, calibrations, anthropicResults));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
