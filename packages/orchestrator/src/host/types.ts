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
  message(runId: string, text: string): boolean;
}

/** How the host reports back, and the one question it asks: implemented by
 * the runner, which owns the ledger. */
export interface HostEvents {
  runFinished(runId: string, result: HostRunResult, at: number): void;
  heartbeat(runId: string, at: number): void;
  /** True when this lane has run out of work and its shift should end rather
   * than be re-prompted. The policy (which lanes end this way, and what
   * counts as drained) lives in the runner; the host only asks. */
  laneDrained(taskId: string): boolean;
}
