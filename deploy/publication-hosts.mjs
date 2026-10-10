import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function hostWaitKind(wait) {
  switch (wait.kind) {
    case "live-meeting": return "waiting-for-live-meetings";
    case "live-telephone": return "waiting-for-live-telephone-calls";
    case "native-source": return "waiting-for-native-source";
    case "native-history": return "waiting-for-native-history";
    case "native-history-custody": return "waiting-for-native-history-custody";
    case "host-lock": return "waiting-for-host-deployment-lock";
    case "host-delivery": return "waiting-for-host-delivery";
    case "thread-contract": return "waiting-for-thread-execution-contract";
    default: throw new Error(`Unknown host wait: ${wait.kind}`);
  }
}

const ownedPaths = [
  ["hosts"], ["reservations"], ["executorHandoffs"],
  ["nativeHistory", "hosts"], ["bootstrap", "hosts"],
  ["maintenance", "hosts"], ["android", "hosts"],
];
const terminal = new Set(["passed", "waiting", "failed"]);
const now = () => new Date().toISOString();
const clone = value => structuredClone(value);
const read = path => JSON.parse(readFileSync(path, "utf8"));

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function safe(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`Invalid host lane identity: ${value}`);
  return value;
}

function directory(root, requestId, integrationSha, hostId) {
  return join(root, safe(requestId), safe(integrationSha), safe(hostId));
}

export function hostLaneLockPath(root, hostId) {
  const path = join(root, "locks", `${safe(hostId)}.lock`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return path;
}

function journalPath(root, requestId, integrationSha, hostId) {
  return join(directory(root, requestId, integrationSha, hostId), "journal.json");
}

export function readHostLane(root, requestId, integrationSha, hostId) {
  const path = journalPath(root, requestId, integrationSha, hostId);
  if (!existsSync(path)) return null;
  const lane = read(path);
  if (lane.version !== 1 || lane.requestId !== requestId || lane.integrationSha !== integrationSha || lane.hostId !== hostId
    || !Number.isSafeInteger(lane.revision) || lane.revision < 1
    || !["queued", "running", "recovering", "passed", "waiting", "failed"].includes(lane.state)
    || terminal.has(lane.state) && lane.outcome?.status !== lane.state
    || !Array.isArray(lane.history) || !Array.isArray(lane.fields) || lane.fields.length !== ownedPaths.length) {
    throw new Error(`Invalid host lane journal: ${path}`);
  }
  return lane;
}

export function hostLaneInputPath(root, requestId, integrationSha, hostId) {
  const lane = readHostLane(root, requestId, integrationSha, hostId);
  if (!lane) throw new Error(`No queued host lane for ${requestId}/${hostId}`);
  return lane.inputPath;
}

function container(request, path) {
  return path.reduce((value, key) => value?.[key], request);
}

function capture(request, hostId) {
  return ownedPaths.map(path => {
    const map = container(request, path);
    return Object.hasOwn(map ?? {}, hostId) ? { present: true, value: clone(map[hostId]) } : { present: false };
  });
}

function apply(request, hostId, fields) {
  if (!Array.isArray(fields) || fields.length !== ownedPaths.length) throw new Error("Invalid host lane fields");
  for (const [index, path] of ownedPaths.entries()) {
    const field = fields[index];
    if (field.present === false) { const map = container(request, path); if (map) delete map[hostId]; continue; }
    if (field.present !== true || !Object.hasOwn(field, "value")) throw new Error("Invalid host lane field");
    let map = request;
    for (const key of path) map = map[key] ??= {};
    map[hostId] = clone(field.value);
  }
}

function isolate(request, hostId) {
  const local = clone(request);
  for (const path of ownedPaths) {
    const map = container(local, path);
    if (map) for (const key of Object.keys(map)) if (key !== hostId) delete map[key];
  }
  delete local.hostDelivery;
  delete local.stageTimings;
  return local;
}

function deliveryWait(lane) {
  return { status: "waiting", waiting: { kind: "host-delivery", host: lane.hostId, at: lane.startedAt ?? lane.queuedAt,
    reason: `${lane.hostId} delivery is owned by its durable host worker.`, inputPath: lane.inputPath } };
}

export function mergeHostLanes(request, root, targets) {
  if (!request.integrationSha) return request;
  for (const { id } of targets) {
    const lane = readHostLane(root, request.requestId, request.integrationSha, id);
    if (!lane) continue;
    const previous = request.hosts?.[id];
    apply(request, id, lane.fields);
    (request.hostDelivery ??= {})[id] = {
      state: lane.state, revision: lane.revision, inputPath: lane.inputPath,
      queuedAt: lane.queuedAt, startedAt: lane.startedAt, updatedAt: lane.updatedAt,
      step: lane.step, progress: clone(lane.progress), worker: clone(lane.worker),
      timings: clone(lane.timings), recovery: clone(lane.recovery), recoveries: clone(lane.recoveries),
    };
    if (terminal.has(lane.state)) {
      request.hosts[id] = clone(lane.outcome);
      if (lane.state === "waiting" && previous?.status === "waiting"
        && previous.waiting?.kind === lane.outcome.waiting?.kind && previous.waiting?.at === lane.outcome.waiting?.at
        && Object.hasOwn(previous, "ready")) request.hosts[id].ready = previous.ready;
    } else (request.hosts ??= {})[id] = deliveryWait(lane);
  }
  if (request.android) {
    const delivered = targets.filter(target => request.android.hosts?.[target.id]);
    request.android.status = delivered.length === targets.length ? "published" : delivered.length ? "partial" : "prepared";
  }
  return request;
}

function queueLane(request, root, hostId, previousLane) {
  const token = randomUUID();
  const inputPath = join(directory(root, request.requestId, request.integrationSha, hostId), `input-${token}.json`);
  const local = isolate(request, hostId);
  const at = now();
  const lane = { version: 1, requestId: request.requestId, integrationSha: request.integrationSha, hostId,
    token, inputPath, revision: (previousLane?.revision ?? 0) + 1,
    state: "queued", queuedAt: at, updatedAt: at, fields: capture(local, hostId),
    step: local.step ?? null, progress: local.progress ?? null, timings: {}, worker: null,
    history: previousLane ? [...previousLane.history, { token: previousLane.token, state: previousLane.state,
      outcome: previousLane.outcome ?? null, inputPath: previousLane.inputPath, updatedAt: previousLane.updatedAt,
      fields: previousLane.fields, timings: previousLane.timings, recoveries: previousLane.recoveries ?? [] }] : [],
  };
  atomicWrite(inputPath, { version: 1, token, root, request: local, hostId });
  atomicWrite(journalPath(root, request.requestId, request.integrationSha, hostId), lane);
  return lane;
}

function summarize(request, targets) {
  const waiting = targets.filter(({ id }) => !["passed", "failed"].includes(request.hosts[id]?.status)).map(({ id }) => id);
  if (waiting.length) return { status: "waiting", hosts: waiting };
  const failed = targets.filter(({ id }) => request.hosts[id]?.status === "failed").map(({ id }) => id);
  return failed.length ? { status: "failed", hosts: failed } : { status: "passed" };
}

// launch acknowledges systemd custody, not completion. The source coordinator never waits for delivery.
export function rollForwardHosts(request, targets, operations) {
  const { laneRoot, launch, active, save } = operations;
  if (typeof laneRoot !== "string" || !laneRoot || typeof launch !== "function" || typeof active !== "function" || typeof save !== "function") {
    throw new Error("Host lanes require laneRoot, launch, active and save");
  }
  mergeHostLanes(request, laneRoot, targets);
  request.hosts ??= {};
  for (const target of targets) {
    let lane = readHostLane(laneRoot, request.requestId, request.integrationSha, target.id);
    const previous = request.hosts[target.id];
    if (previous?.status === "passed" || previous?.status === "failed") continue;
    if (previous?.status === "waiting" && previous.ready === false) continue;
    let isActive;
    let probeError;
    try {
      isActive = active(target, lane);
      if (typeof isActive !== "boolean") throw new Error(`Invalid host worker activity for ${target.id}`);
    } catch (error) { probeError = error instanceof Error ? error.message : String(error); }
    if (!isActive) {
      // An inactive running lane keeps its token and custody: the worker must recover before replay.
      if (!lane || terminal.has(lane.state)) lane = queueLane(request, laneRoot, target.id, lane);
      let result;
      if (probeError) result = { ok: false, error: probeError };
      else {
        try { result = launch(target, lane.inputPath); }
        catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      }
      if (!result || typeof result.ok !== "boolean") throw new Error(`Invalid host launch result for ${target.id}`);
      if (!result.ok) {
        request.hosts[target.id] = { status: "waiting", waiting: { kind: "host-delivery", host: target.id, at: lane.queuedAt,
          reason: `Host worker launch failed: ${result.error}`, inputPath: lane.inputPath } };
        (request.hostDelivery ??= {})[target.id] = { state: lane.state, revision: lane.revision, launchError: String(result.error) };
        save(request);
        continue;
      }
    }
    mergeHostLanes(request, laneRoot, targets);
    save(request);
  }
  // Peers may finish during the launches; harvest without writing their journals.
  mergeHostLanes(request, laneRoot, targets);
  save(request);
  return summarize(request, targets);
}

// The coordinator observes a settled lane while holding its host flock. No source receipt
// write substitutes for this target journal transition.
export function reconcileHostLaneObservation(inputPath, request, expectedRevision) {
  const input = read(inputPath);
  if (input.version !== 1 || request.requestId !== input.request.requestId || request.integrationSha !== input.request.integrationSha) {
    return { ok: false, error: { kind: "host-observation-identity-conflict" } };
  }
  const { root, hostId, token } = input;
  const lane = readHostLane(root, request.requestId, request.integrationSha, hostId);
  if (!lane || lane.token !== token || lane.inputPath !== inputPath || lane.revision !== expectedRevision) {
    return { ok: false, error: { kind: "host-observation-conflict", revision: lane?.revision ?? null } };
  }
  if (!terminal.has(lane.state)) return { ok: false, error: { kind: "host-observation-busy", state: lane.state } };
  const outcome = request.hosts?.[hostId];
  if (!outcome || !terminal.has(outcome.status)) return { ok: false, error: { kind: "host-observation-invalid-outcome" } };
  const fields = capture(request, hostId);
  if (JSON.stringify(fields) === JSON.stringify(lane.fields) && JSON.stringify(outcome) === JSON.stringify(lane.outcome)) {
    return { ok: true, revision: lane.revision, changed: false };
  }
  const next = { ...lane, state: outcome.status, outcome: clone(outcome), fields,
    revision: lane.revision + 1, updatedAt: now(),
    observations: [...(lane.observations ?? []), { at: now(), revision: lane.revision, state: lane.state,
      outcome: lane.outcome, fields: lane.fields }],
  };
  atomicWrite(journalPath(root, request.requestId, request.integrationSha, hostId), next);
  return { ok: true, revision: next.revision, changed: true };
}

function workerContext(inputPath, operations) {
  const input = read(inputPath);
  if (input.version !== 1 || typeof operations.bind !== "function" || typeof operations.recover !== "function") {
    throw new Error("Invalid host lane input or worker operations");
  }
  const { root, request: snapshot, hostId, token } = input;
  const lane = readHostLane(root, snapshot.requestId, snapshot.integrationSha, hostId);
  if (!lane || lane.token !== token || lane.inputPath !== inputPath) throw new Error("Host lane input has been superseded");
  const local = isolate(snapshot, hostId);
  apply(local, hostId, lane.fields);
  if (lane.timings) local.stageTimings = clone(lane.timings);
  const path = journalPath(root, snapshot.requestId, snapshot.integrationSha, hostId);
  const context = { lane, local, hostId };
  context.checkpoint = request => {
    const current = readHostLane(root, lane.requestId, lane.integrationSha, hostId);
    if (request.requestId !== lane.requestId || request.integrationSha !== lane.integrationSha) throw new Error("Host worker changed its immutable integration identity");
    if (current.token !== token || current.revision !== context.lane.revision) throw new Error("Host lane checkpoint lost custody");
    context.lane = { ...context.lane, revision: context.lane.revision + 1, updatedAt: now(), fields: capture(request, hostId),
      step: request.step ?? null, progress: request.progress ?? null, timings: clone(request.stageTimings ?? {}) };
    atomicWrite(path, context.lane);
  };
  operations.bind(local, context.checkpoint);
  return context;
}

const workerIdentity = () => ({ pid: process.pid, bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() });

// Both worker APIs execute under a process-lifetime flock at hostLaneLockPath(root, hostId).
// bind installs checkpoint as the worker's writeRequest adapter before any effect.
export function runHostLane(inputPath, operations) {
  if (typeof operations.deliver !== "function") throw new Error("Host lane requires deliver");
  const context = workerContext(inputPath, operations);
  const { local, hostId, checkpoint } = context;
  if (terminal.has(context.lane.state)) return clone(context.lane.outcome);
  if (context.lane.recovery?.status === "running") throw new Error("Explicit host recovery must resume through runHostLaneRecovery");
  const previous = local.hosts?.[hostId];
  const interrupted = ["running", "recovering"].includes(context.lane.state);
  Object.assign(context.lane, { worker: workerIdentity(), startedAt: now(), state: interrupted ? "recovering" : "running" });
  checkpoint(local);
  let outcome;
  try {
    if (interrupted) {
      const recovered = operations.recover(local);
      if (recovered?.then) throw new Error("Host recovery callback must be synchronous");
      context.lane.state = "running";
      checkpoint(local);
    }
    outcome = operations.deliver(local, previous);
    if (!outcome || !terminal.has(outcome.status)) throw new Error(`Invalid host outcome for ${hostId}`);
  } catch (error) {
    outcome = { status: "failed", failure: { at: now(), message: error instanceof Error ? error.message : String(error),
      step: local.step, progress: clone(local.progress) } };
  }
  (local.hosts ??= {})[hostId] = outcome;
  context.lane.state = outcome.status;
  context.lane.outcome = outcome;
  checkpoint(local);
  return outcome;
}

export function runHostLaneRecovery(inputPath, operations) {
  const context = workerContext(inputPath, operations);
  const { local, checkpoint } = context;
  const prior = context.lane.recovery?.status === "running" ? context.lane.recovery : {
    state: context.lane.state, outcome: context.lane.outcome, startedAt: now(), status: "running",
  };
  if (!terminal.has(prior.state)) throw new Error("Explicit recovery requires a settled host outcome");
  Object.assign(context.lane, { state: "recovering", recovery: prior, worker: workerIdentity() });
  checkpoint(local);
  let result;
  try {
    const recovered = operations.recover(local);
    if (recovered?.then) throw new Error("Host recovery callback must be synchronous");
    result = { ok: true };
  }
  catch (error) { result = { ok: false, error: { kind: "host-recovery-failed", message: error instanceof Error ? error.message : String(error) } }; }
  const recovery = { ...prior, status: result.ok ? "completed" : "failed", finishedAt: now(), result };
  context.lane.state = prior.state;
  context.lane.outcome = prior.outcome;
  context.lane.recovery = recovery;
  context.lane.recoveries = [...(context.lane.recoveries ?? []), recovery];
  checkpoint(local);
  return result;
}
