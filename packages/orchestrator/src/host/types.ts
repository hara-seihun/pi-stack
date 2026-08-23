/**
 * How many check-ins the host may send before it stops re-prompting a shift.
 *
 * A shift is bounded by asks, not by a clock. The host used to stop at a
 * four-hour budget, which put a deadline into a system whose whole argument
 * is that a hard problem deserves however long it takes; agents also invent
 * deadlines readily on their own (transcript audit 2026-08-23), and a real
 * one behind them made the invention true. Six work turns — the task prompt
 * plus five check-ins — is the host's whole claim on a session now, and each
 * may run as long as the mathematics needs.
 *
 * It counts messages sent, not turns judged. The rule it replaced ended a
 * shift after two turns that filed no report, which sounds like the same
 * thing and is not: an agent filing a running report every turn was never
 * idle by that measure, so nothing but the clock bounded how often it was
 * kicked back — one math-cleanup session took 52 kick-backs and spent them
 * pinned against the context cap, saying so in its own reasoning.
 *
 * It is a constant and not a knob. The override that used to exist could
 * only make a shift longer, and a non-numeric one removed the cap outright
 * (`turn >= NaN` is false forever), which is the shape of the failure it
 * exists to prevent.
 */
export const MAX_CHECK_INS = 5;

/**
 * What the controller hands a host to start one agent session. Deliberately
 * carries no tier: tier labels are launch-side data and must never reach a
 * host, a session, or any agent-visible surface.
 */
export interface LaunchSpec {
  readonly runId: string;
  readonly taskId: string;
  readonly prompt: string;
  readonly cwd: string | undefined;
  readonly provider: string;
  readonly model: string;
  readonly thinking: string | undefined;
  readonly accountId: string;
  /** URL of doctrine to pin into the session's system prompt, where it
   * survives compaction; the task prompt, as the first user message, does
   * not. */
  readonly doctrineUrl?: string;
  /** User messages sent as real turns before the task prompt; the lived
   * exchange is then pinned verbatim through every compaction. */
  readonly opening?: readonly string[];
  /** Command whose JSON stdout fills `{{key}}` placeholders in the opening
   * messages, run fresh at every launch (see tasks/types.ts). */
  readonly openingProbe?: string;
  /** One work turn, no continuation check-ins: the agent ending its turn
   * ends the shift. */
  readonly selfPaced?: boolean;
}

/** Result a host reports when a session ends. */
export interface HostRunResult {
  readonly state: "done" | "error" | "aborted";
  readonly productive?: boolean;
  readonly complete?: boolean;
  readonly detail?: string;
}

/**
 * A host runs agent sessions. `launch` must not throw and must eventually
 * cause exactly one `runFinished` report for the run; `abort` is best-effort.
 * `message` delivers an operator turn into a live session and reports whether
 * this host still holds it — killing an agent must not be the only way to
 * change what it is doing.
 */
export interface HostManager {
  launch(spec: LaunchSpec): void;
  abort(runId: string): void;
  /**
   * Tear the session down without waiting for the provider to unwind, and
   * report the run finished. `abort` asks the agent loop to stop and depends
   * on the in-flight turn returning; a session parked inside a provider call
   * never returns, so a stalled run needs an exit that does not consult it.
   */
  kill(runId: string, detail: string): void;
  /** Runs this host still holds a live session for. */
  liveRuns(): readonly string[];
  message(runId: string, text: string): boolean;
}

/** How the host reports back, and the one question it asks: implemented by
 * the runner, which owns the ledger. */
export interface HostEvents {
  runFinished(runId: string, result: HostRunResult, at: number): void;
  heartbeat(runId: string, at: number): void;
  /** The session did something the transcript recorded. Distinct from
   * `heartbeat`, which only says the hosting process is alive. */
  progress(runId: string, at: number): void;
  /** The pi session now hosting this run. Reported once, as soon as the
   * session exists, so the usage the session is about to record is
   * attributable to the lane that asked for it. */
  sessionStarted(runId: string, sessionId: string): void;
  /** True when this lane has run out of work and its shift should end rather
   * than be re-prompted. The policy (which lanes end this way, and what
   * counts as drained) lives in the runner; the host only asks. */
  laneDrained(taskId: string): boolean;
  /** May the host kick this shift back once more? Answered from the run's
   * own spent check-ins, so the budget is a fact about the run and not a
   * counter inside whichever process happens to be hosting it. */
  claimCheckIn(runId: string): boolean;
}
