// The consumer half of a local engine's maintenance reservation, for the supervisor.
//
// A maintenance holder — a benchmark, a repair, anything that needs the accelerator to itself — takes
// the engine's lock file exclusively for as long as the engine must stay down. Every consumer takes it
// shared around admission — probing the engine, starting it, waiting for it to answer — so the pause
// holds and nobody has a check-then-start window.
//
// Naming is short, bounded background work, so the supervisor holds its lease across the completion as
// well: a pause that begins mid-title waits a second or two rather than killing it. A Pi session's own
// model requests are not leased; see the contract for why.
//
// `packages/runtime/extensions/local-models/reservation.mjs` owns the contract and the same protocol
// for Pi sessions. Remote deploys as its own tree under Bun, so it carries this second implementation
// rather than importing that one; the manifest field names, defaults and lock semantics must match.
import { spawn } from "node:child_process";

export interface EngineReservation { lock: string; waitSeconds: number }

/** A consumer that finds the engine reserved reports it rather than waiting, unless the manifest says otherwise. */
export const RESERVATION_DEFAULT_WAIT_SECONDS = 0;
const RELEASE_GRACE_MS = 2_000;
const HELD = "held";

/** The supervisor names threads in the background, so it defers the moment it meets a maintenance holder. */
export const BACKGROUND_RESERVATION_WAIT_SECONDS = 0;

/** Thrown when a maintenance holder has the engine. Its callers retry after the lease instead of failing the work. */
export class EngineReservedError extends Error {
  constructor(readonly engineId: string, readonly detail: string) {
    super(`Local engine ${engineId} is reserved for maintenance: ${detail}`);
    this.name = "EngineReservedError";
  }
}

export function parseEngineReservation(raw: any, engineId: string): EngineReservation | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Local engine ${engineId}: reservation must be an object`);
  if (typeof raw.lock !== "string" || !raw.lock.startsWith("/")) throw new Error(`Local engine ${engineId}: reservation.lock must be an absolute path`);
  if (raw.waitSeconds !== undefined && (!Number.isFinite(raw.waitSeconds) || raw.waitSeconds < 0)) throw new Error(`Local engine ${engineId}: reservation.waitSeconds must be a non-negative number of seconds`);
  return { lock: raw.lock, waitSeconds: raw.waitSeconds === undefined ? RESERVATION_DEFAULT_WAIT_SECONDS : raw.waitSeconds };
}

/** The exact `flock` invocation a consumer runs, shared with the tests and the contract. */
export function leaseCommand(reservation: EngineReservation, waitSeconds: number): [string, string[]] {
  const wait = Number.isFinite(waitSeconds) && waitSeconds > 0 ? ["--timeout", String(waitSeconds)] : ["--nonblock"];
  // The lock lives in the child: `cat` holds it until its stdin closes, which also happens when this
  // process dies, so a crashed supervisor cannot leave an engine reserved against maintenance.
  return ["flock", ["--shared", ...wait, "--conflict-exit-code", "75", reservation.lock, "sh", "-c", `printf '${HELD}\\n'; exec cat`]];
}

export type ReservationLease =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; reserved: boolean; detail: string };

/**
 * Take the shared side of a reservation. A lock that cannot be evaluated is a refusal, not a pass: a
 * declared reservation is never silently ignored.
 */
export function acquireReservation(reservation: EngineReservation, waitSeconds = reservation.waitSeconds, spawnImpl = spawn): Promise<ReservationLease> {
  const [file, args] = leaseCommand(reservation, waitSeconds);
  const waited = waitSeconds > 0 ? `, waited ${waitSeconds} s` : "";
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawnImpl(file, args, { stdio: ["pipe", "pipe", "ignore"] }); }
    catch (error) { resolve({ ok: false, reserved: false, detail: `cannot run ${file} for ${reservation.lock}: ${(error as Error).message}` }); return; }
    let settled = false;
    const settle = (value: ReservationLease) => { if (!settled) { settled = true; resolve(value); } };
    child.on("error", (error) => settle({ ok: false, reserved: false, detail: `cannot run ${file} for ${reservation.lock}: ${error.message}` }));
    child.on("exit", (code, signal) => settle(code === 75
      ? { ok: false, reserved: true, detail: `another holder has ${reservation.lock}${waited}` }
      : { ok: false, reserved: false, detail: `${file} ${reservation.lock} exited ${signal ?? code} without taking the lock` }));
    child.stdout!.setEncoding("utf8");
    let seen = "";
    child.stdout!.on("data", (chunk: string) => {
      seen += chunk;
      if (seen.includes(HELD)) settle({ ok: true, release: () => release(child) });
    });
  });
}

function release(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, RELEASE_GRACE_MS);
    child.on("exit", () => { clearTimeout(timer); resolve(); });
    child.stdin!.end();
  });
}

/**
 * Run `work` holding the engine's shared reservation. An engine without one runs `work` directly.
 * A maintenance holder, or a lock that cannot be evaluated, throws `EngineReservedError`.
 */
export async function withEngineReservation<T>(
  engineId: string,
  reservation: EngineReservation | undefined,
  waitSeconds: number,
  work: () => Promise<T>,
  spawnImpl = spawn,
): Promise<T> {
  if (!reservation) return work();
  const lease = await acquireReservation(reservation, waitSeconds, spawnImpl);
  if (!lease.ok) throw new EngineReservedError(engineId, lease.detail);
  try { return await work(); }
  finally { await lease.release(); }
}
