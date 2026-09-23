// A maintenance reservation makes one engine's admission explicit, so a benchmark, a repair or any
// other job that needs the accelerator can pause the engine without the next Pi session bringing it
// straight back.
//
// The protocol is one flock(2) file per engine, named by the engine's manifest entry:
//
//   * A maintenance holder takes the file EXCLUSIVELY for as long as the engine must stay down.
//   * Every Pi consumer takes it SHARED around admission: probing the engine, starting it, and
//     waiting for it to answer.
//
// The lease is admission-scoped, not request-scoped. Model requests a Pi session then makes through
// the registered provider go out under Pi's own client and are not leased: a session-lifetime shared
// lease would deny maintenance for as long as the session lived. While the engine is paused those
// requests fail, which is the true state of the engine. A short, bounded consumer may choose to hold
// its lease across its own request instead; Pi Remote's thread naming does.
//
// Shared holders keep a maintenance holder out while an engine is genuinely coming up, and an
// exclusive holder keeps every consumer out, so neither side has a check-then-start window. The
// kernel owns the state: it is the same lock a shell takes with `exec 9>PATH; flock 9`, and it is
// released when the last holder's descriptor closes, including when the holder dies.
//
// This file is the contract for both implementations of the consumer half. The other one is Pi
// Remote's `apps/remote/server/engine-reservation.ts`, which runs under Bun in a separate deployed
// tree; keep the manifest field names, defaults and lock semantics identical in the two.
import { spawn } from "node:child_process";

/** A consumer that finds the engine reserved reports it rather than waiting, unless the manifest says otherwise. */
export const RESERVATION_DEFAULT_WAIT_SECONDS = 0;

/** How long a consumer keeps trying to release a lease before it gives up on a clean exit. */
const RELEASE_GRACE_MS = 2_000;

const HELD = "held";

/** Parse an engine's optional `reservation`. `fail` throws the manifest's own error. */
export function parseReservation(raw, fail, where) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) fail(`${where}.reservation must be an object`);
  if (typeof raw.lock !== "string" || !raw.lock.startsWith("/")) fail(`${where}.reservation.lock must be an absolute path`);
  if (raw.waitSeconds !== undefined && (!Number.isFinite(raw.waitSeconds) || raw.waitSeconds < 0)) fail(`${where}.reservation.waitSeconds must be a non-negative number of seconds`);
  return { lock: raw.lock, waitSeconds: raw.waitSeconds === undefined ? RESERVATION_DEFAULT_WAIT_SECONDS : raw.waitSeconds };
}

/** The exact `flock` invocation a consumer runs. Exported so the tests and the docs read the same command. */
export function leaseCommand(reservation, waitSeconds) {
  const wait = Number.isFinite(waitSeconds) && waitSeconds > 0 ? ["--timeout", String(waitSeconds)] : ["--nonblock"];
  // The held lock lives in the child: `cat` keeps it until its stdin closes, which also happens when
  // this process dies, so a crashed consumer cannot leave the engine reserved against maintenance.
  return ["flock", ["--shared", ...wait, "--conflict-exit-code", "75", reservation.lock, "sh", "-c", `printf '${HELD}\\n'; exec cat`]];
}

/**
 * Take the shared side of an engine's reservation.
 *
 * Resolves `{ ok: true, release }`, `{ ok: false, reserved: true, detail }` when a maintenance holder
 * has it, or `{ ok: false, reserved: false, detail }` when the lock cannot be evaluated at all. An
 * unevaluable reservation is a refusal, not a pass: a declared reservation is never silently ignored.
 */
export function acquireReservation(reservation, { waitSeconds = reservation.waitSeconds, spawnImpl = spawn } = {}) {
  const [file, args] = leaseCommand(reservation, waitSeconds);
  const waited = waitSeconds > 0 ? `, waited ${waitSeconds} s` : "";
  return new Promise((resolve) => {
    let child;
    try { child = spawnImpl(file, args, { stdio: ["pipe", "pipe", "ignore"] }); }
    catch (error) { resolve({ ok: false, reserved: false, detail: `cannot run ${file} for ${reservation.lock}: ${error.message}` }); return; }
    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    child.on("error", (error) => settle({ ok: false, reserved: false, detail: `cannot run ${file} for ${reservation.lock}: ${error.message}` }));
    child.on("exit", (code, signal) => settle(code === 75
      ? { ok: false, reserved: true, detail: `another holder has ${reservation.lock}${waited}` }
      : { ok: false, reserved: false, detail: `${file} ${reservation.lock} exited ${signal ?? code} without taking the lock` }));
    child.stdout.setEncoding("utf8");
    let seen = "";
    child.stdout.on("data", (chunk) => {
      seen += chunk;
      if (!seen.includes(HELD)) return;
      settle({ ok: true, lock: reservation.lock, release: () => release(child) });
    });
  });
}

function release(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, RELEASE_GRACE_MS);
    child.on("exit", () => { clearTimeout(timer); resolve(); });
    child.stdin.end();
  });
}

/**
 * Run `work` holding the engine's shared reservation, resolving `{ leased: true, value }`. An engine
 * without a reservation runs `work` directly, so a host that never declares one behaves exactly as it
 * did before. A refusal resolves `{ leased: false, reserved, detail }` and never runs `work`.
 */
export async function withReservation(reservation, options, work) {
  if (!reservation) return { leased: true, value: await work() };
  const lease = await acquireReservation(reservation, options);
  if (!lease.ok) return { leased: false, reserved: lease.reserved, detail: lease.detail };
  try { return { leased: true, value: await work() }; }
  finally { await lease.release(); }
}
