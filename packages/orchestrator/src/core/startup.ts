export type CoreStartupPhase = "scope-adoption" | "provider-adoption" | "memory-adoption" | "image-adoption" | "duty-adoption" | "root-adoption" | "callback-transports" | "http-listen" | "scope-activation" | "provider-transports" | "gateway-transports" | "initial-reconciliation" | "ready" | "failed";
export type CoreStartupObservation = { phase: CoreStartupPhase; elapsedMs: number; phaseElapsedMs: number };

/** Only phase names and monotonic durations cross this observation boundary. */
export class CoreStartupClock {
  private phase: CoreStartupPhase = "scope-adoption";
  private readonly startedAt: number;
  private phaseStartedAt: number;
  constructor(private readonly now: () => number, private readonly report: (observation: CoreStartupObservation) => void) {
    this.startedAt = this.phaseStartedAt = now();
    report(this.snapshot());
  }
  snapshot(): CoreStartupObservation {
    const time = this.now();
    return { phase: this.phase, elapsedMs: Math.round(time - this.startedAt), phaseElapsedMs: Math.round(time - this.phaseStartedAt) };
  }
  enter(phase: CoreStartupPhase): void {
    if (this.phase === phase) return;
    this.report(this.snapshot());
    this.phase = phase;
    this.phaseStartedAt = this.now();
    this.report(this.snapshot());
  }
}
