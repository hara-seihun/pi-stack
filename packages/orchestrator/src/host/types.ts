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
 * exists to prevent. Team sessions do not use this budget. Pi messages pace
 * their turns until the operator changes the lane's desired state.
 */
export const MAX_CHECK_INS = 5;

/**
 * What the controller hands a host to start one agent session. Deliberately
 * carries no tier: tier labels are launch-side data and must never reach a
 * host, a session, or any agent-visible surface.
 */
export interface TeamLaunch {
  readonly role: "worker" | "supervisor";
  readonly slot: number;
  readonly workers: number;
  /** A recovered idle worker waits for its next supervisor message instead
   * of inventing a process-recovery turn. */
  readonly idleAt?: number;
}

export interface HostMessage {
  readonly text: string;
  /** Present for a Pi message sent by another team session. Operator messages
   * omit it and use Pi's native steering behavior. */
  readonly senderRunId?: string;
  /** A supervisor's assistant response to this turn is delivered here. */
  readonly replyRunId?: string;
  /** Idle generation the response belongs to. */
  readonly replyIdleAt?: number;
}

export interface TeamIdle {
  readonly taskId: string;
  readonly workerRunId: string;
  readonly idleAt: number;
  readonly contextSince: number;
}

export interface LaunchSpec {
  readonly runId: string;
  readonly taskId: string;
  readonly prompt: string;
  readonly cwd: string | undefined;
  readonly provider: string;
  readonly model: string;
  readonly thinking: string | undefined;
  readonly accountId: string;
  /** Existing Pi session file recovered after its hosting runner vanished.
   * The replacement host appends to this same conversation instead of
   * starting the task again. */
  readonly resumeSessionFile?: string;
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
   * ends an ordinary shift. Team sessions instead wait for one another. */
  readonly selfPaced?: boolean;
  readonly team?: TeamLaunch;
}

/** Result a host reports when a session ends. */
export interface HostRunResult {
  readonly state: "done" | "error" | "aborted";
  readonly detail?: string;
}

/**
 * A host runs agent sessions. `launch` must not throw and must eventually
 * cause exactly one `runFinished` report for the run; `abort` is best-effort.
 * `message` delivers a Pi turn into a live session and reports whether this
 * host still holds it. Killing an agent must not be the only way to change
 * what it is doing.
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
  message(runId: string, message: HostMessage): boolean;
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
  sessionStarted(runId: string, sessionId: string, sessionFile?: string): void;
  /** Record that a worker's Pi turn settled and notify the supervisor. */
  teamWorkerIdle(workerRunId: string): TeamIdle;
  /** Route the supervisor's Pi response to the idle worker it was answering. */
  teamSupervisorResponded(
    supervisorRunId: string,
    workerRunId: string,
    idleAt: number,
    text: string,
  ): boolean;
  /** Resolve the readable Pi session for one worker on this supervisor's team. */
  teamWorkerSession(
    supervisorRunId: string,
    workerRunId: string,
  ): { runId: string; sessionFile?: string };
  /** True when this lane has run out of work and its shift should end rather
   * than be re-prompted. The policy (which lanes end this way, and what
   * counts as drained) lives in the runner; the host only asks. */
  laneDrained(taskId: string): boolean;
  /** May the host kick this shift back once more? Answered from the run's
   * own spent check-ins, so the budget is a fact about the run and not a
   * counter inside whichever process happens to be hosting it. */
  claimCheckIn(runId: string): boolean;
  /**
   * A turn ended in a provider error. Answers how long this session should
   * wait before picking the shift back up, or `undefined` when there is
   * nothing to wait for and the run should end.
   *
   * A provider error used to be terminal: pi's own retry covers seconds, and
   * once it was spent the host returned `error` and the session was disposed
   * mid-thought. On 2026-08-23 an upstream pool throttled `ox-alpha` for two
   * hours and killed four sessions that way, three of them an hour deep into
   * work nobody got back. The condition lasted seconds at a time; the sessions
   * did not have to.
   *
   * `attempt` counts consecutive failures in this shift and resets whenever a
   * turn lands, so the backoff climbs through a bad patch and starts over
   * after a good one. The policy lives in the runner, which knows the account,
   * its family, and how long that family's failures usually last.
   */
  turnFailed(runId: string, detail: string, attempt: number): number | undefined;
}
