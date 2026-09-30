import type { MeetSnapshot, MeetVoiceWake } from "../../../server/meet/protocol";

/**
 * GPT-Live bills every second a session is open, muted or not. A meeting with
 * a platform transcript therefore keeps Voice closed until Kenan is unmuted or
 * someone says his name, and closes it again once he has been muted and quiet
 * for a minute, or unmuted with nothing to do for eight. Unmuting is a person asking
 * Kenan to take part: in the Sprint Demos rehearsal on 2026-09-29 a three-minute
 * bound closed Voice while the room watched his sizzle video, and the next request
 * ("Kenan, …", heard by Recall as "Kevin") was missed. Eight minutes costs at most
 * $0.25 more per unmute, and stays inside the ten-minute work hold.
 */
export const VOICE_MUTED_LINGER_MS = 60_000;
export const VOICE_UNMUTED_IDLE_MS = 8 * 60_000;
/** A failed open is retried no sooner than this while Voice is still wanted. */
export const VOICE_RETRY_MS = 15_000;
/** A mention finalized this soon after Voice went live was probably spoken before it could hear. */
export const VOICE_HEARING_MS = 5_000;
/** An unsettled delegation keeps unmuted Voice open for at most this long; a lost settlement must not hold it open all meeting. */
export const VOICE_WORK_HOLD_MS = 10 * 60_000;

export function pendingWork(delegations: ReadonlyArray<{ createdAt?: number }>, now: number): boolean {
  return delegations.some((delegation) => now - (delegation.createdAt ?? 0) < VOICE_WORK_HOLD_MS);
}

export interface VoiceDemandInput {
  muted: boolean;
  /** Without speaker-labelled platform turns there is no cheap wake signal, so Voice stays open for the whole meeting. */
  platformTranscript: boolean;
  /** Voice has recently delegated work that has not settled; its answer should still be heard. */
  working: boolean;
  now: number;
  lastActivityAt: number;
}

export function voiceWanted(input: VoiceDemandInput): boolean {
  if (!input.platformTranscript) return true;
  const idle = input.now - input.lastActivityAt;
  return input.muted ? idle < VOICE_MUTED_LINGER_MS : input.working || idle < VOICE_UNMUTED_IDLE_MS;
}

export interface DemandVoice {
  readonly state: string;
  readonly working: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Opens and closes one meeting's Voice session from room snapshots and Kenan's own activity. */
export class VoiceDemand {
  private muted = true;
  private platformTranscript = true;
  private wakeRevision: number | null = null;
  private lastActivityAt = Number.NEGATIVE_INFINITY;
  private liveSince: number | null = null;
  private failedAt = Number.NEGATIVE_INFINITY;
  private transition: Promise<void> | null = null;
  private stopped = false;
  private workersRunning = false;

  constructor(private readonly voice: DemandVoice, private readonly clock: () => number = Date.now) {}

  /** Kenan spoke, was handed work, or his mute state changed. */
  activity() { this.lastActivityAt = this.clock(); }

  get wanted(): boolean {
    // Workers report back through the meeting thread, which Voice speaks; keep listening for them, within the same bound as a delegation.
    const workers = this.workersRunning && this.clock() - this.lastActivityAt < VOICE_WORK_HOLD_MS;
    return voiceWanted({ muted: this.muted, platformTranscript: this.platformTranscript, working: this.voice.working || workers,
      now: this.clock(), lastActivityAt: this.lastActivityAt });
  }

  /**
   * Take the room's state. Returns a new mention that Voice did not hear, which
   * the caller hands to Pi; the first snapshot only sets the baseline so a
   * reconnecting host does not replay an old mention.
   */
  observe(snapshot: Pick<MeetSnapshot, "voiceMuted" | "platformTranscript" | "voiceWake"> & Partial<Pick<MeetSnapshot, "threads" | "sessionId">>): MeetVoiceWake | null {
    this.platformTranscript = snapshot.platformTranscript;
    this.workersRunning = (snapshot.threads ?? []).some((thread) => thread.id !== snapshot.sessionId && thread.state === "running" && !thread.held);
    if (snapshot.voiceMuted !== this.muted) { this.muted = snapshot.voiceMuted; this.activity(); }
    const wake = snapshot.voiceWake;
    const first = this.wakeRevision === null;
    const fresh = wake && !first && wake.revision > this.wakeRevision!;
    this.wakeRevision = Math.max(this.wakeRevision ?? 0, wake?.revision ?? 0);
    if (!fresh) return null;
    this.activity();
    return this.hearing() ? null : wake;
  }

  private hearing(): boolean {
    if (this.voice.state !== "live") { this.liveSince = null; return false; }
    return this.liveSince !== null && this.clock() - this.liveSince >= VOICE_HEARING_MS;
  }

  /** Open or close Voice toward the current demand. One transition runs at a time; the next snapshot re-evaluates. */
  reconcile(): Promise<void> | null {
    if (this.stopped || this.transition) return this.transition;
    const now = this.clock();
    if (this.voice.state === "live") this.liveSince ??= now;
    else this.liveSince = null;
    const open = this.voice.state === "live" || this.voice.state === "connecting";
    const wanted = this.wanted;
    if (wanted && !open) {
      if (now - this.failedAt < VOICE_RETRY_MS) return null;
      this.transition = this.voice.start().then(() => {
        if (this.voice.state !== "live") this.failedAt = this.clock();
      });
    } else if (!wanted && this.voice.state === "live") {
      this.transition = this.voice.stop();
    } else return null;
    const current = this.transition;
    void current.finally(() => { if (this.transition === current) this.transition = null; }).catch(() => {});
    return current;
  }

  /** The meeting is ending; the adapter stops Voice itself. */
  stop() { this.stopped = true; }
}
