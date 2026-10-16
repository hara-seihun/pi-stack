// Reachability and on-demand start of a local engine. Started engines run as transient user units so
// they outlive the Pi session that needed them; a direct launcher exists for tests. An engine that
// declares a maintenance reservation is probed, started and awaited under that reservation's shared
// lock, so a benchmark holding it exclusively can pause the engine and keep it paused.
import { spawn } from "node:child_process";
import { withReservation } from "./reservation.mjs";

export async function reachable(baseUrl, timeoutMs = 2000, fetchImpl = fetch) {
  return (await listModels(baseUrl, timeoutMs, fetchImpl)) !== undefined;
}

/** The engine's /models list, or undefined when it does not answer. */
export async function listModels(baseUrl, timeoutMs = 2000, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/models`, { signal: controller.signal });
    if (!response.ok) return undefined;
    const payload = await response.json();
    return Array.isArray(payload?.data) ? payload.data : [];
  } catch { return undefined; }
  finally { clearTimeout(timer); }
}

/** Fill unset context windows from what the engine advertises (`context_window` per model). */
export function applyAdvertised(engine, advertised) {
  const byId = new Map((advertised ?? []).map((model) => [model.id, model]));
  return { ...engine, models: engine.models.map((model) => {
    const info = byId.get(model.id);
    if (!info || !Number.isInteger(info.context_window)) return model;
    return { ...model, contextWindow: model.contextWindowExplicit ? model.contextWindow : info.context_window };
  }) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Launch the engine's start command. Returns a description of what was launched or an error string. */
export function launch(engine, environment = process.env) {
  const direct = environment.PI_STACK_LOCAL_MODELS_LAUNCHER === "direct";
  const [file, ...args] = direct
    ? engine.start.command
    : ["systemd-run", "--user", "--collect", "--quiet", `--unit=${engine.start.unit}`, ...(engine.start.cwd ? [`--working-directory=${engine.start.cwd}`] : []), "--", ...engine.start.command];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { cwd: direct ? engine.start.cwd : undefined, stdio: "ignore", detached: direct, env: environment });
    } catch (error) { resolve({ ok: false, error: `cannot spawn ${file}: ${error.message}` }); return; }
    child.on("error", (error) => resolve({ ok: false, error: `cannot spawn ${file}: ${error.message}` }));
    if (direct) { child.unref(); resolve({ ok: true, description: `${file} (pid ${child.pid})` }); return; }
    child.on("exit", (code) => {
      // systemd-run returns once the unit is queued; a non-zero exit usually means the unit already exists
      // (started by another session), which is fine: the readiness poll below decides.
      resolve({ ok: true, description: `unit ${engine.start.unit}${code ? ` (systemd-run exit ${code})` : ""}` });
    });
  });
}

/**
 * Make sure the engine answers. Returns `{ ready, launched, reserved, detail }`. An engine without a
 * start command is only probed; an engine reserved for maintenance is neither probed nor started, and
 * comes back `reserved: true` so its caller can defer instead of treating it as broken.
 *
 * `waitSeconds` overrides the manifest's bounded wait: a background consumer passes `0` to defer at
 * once, and a foreground one may wait for the engine to be released.
 */
export async function ensureEngine(engine, options = {}) {
  const { waitSeconds = engine.reservation?.waitSeconds, spawnImpl } = options;
  const attempt = await withReservation(engine.reservation, { waitSeconds, ...(spawnImpl ? { spawnImpl } : {}) }, () => ensureReachable(engine, options));
  if (attempt.leased) return attempt.value;
  return { ready: false, launched: false, reserved: attempt.reserved, detail: attempt.reserved ? `reserved for maintenance: ${attempt.detail}` : `reservation unavailable: ${attempt.detail}` };
}

async function ensureReachable(engine, { environment = process.env, fetchImpl = fetch, pollMs = 1000, log = () => {} } = {}) {
  if (await reachable(engine.baseUrl, 2000, fetchImpl)) return { ready: true, launched: false, detail: "already running" };
  if (!engine.start) return { ready: false, launched: false, detail: "not running and no start command" };
  const started = await launch(engine, environment);
  if (!started.ok) return { ready: false, launched: false, detail: started.error };
  log(`started ${engine.id}: ${started.description}; waiting up to ${engine.start.readySeconds} s`);
  const deadline = Date.now() + engine.start.readySeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (await reachable(engine.baseUrl, 2000, fetchImpl)) return { ready: true, launched: true, detail: started.description };
  }
  return { ready: false, launched: true, detail: `${started.description} did not answer within ${engine.start.readySeconds} s` };
}
