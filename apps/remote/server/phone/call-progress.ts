export const CALL_TIMING = { initialQuietMs: 2000, greetingQuietMs: 4000, beepQuietMs: 600, messageQuietMs: 3000, silenceMs: 20000, telemetryMs: 5000 } as const;
export type AudioActivity = { input: boolean; output: boolean; tone: boolean };
export type CallProgressEffect =
  | { type: "opening"; voicemail: boolean }
  | { type: "hold" }
  | { type: "end"; reason: "Voicemail message delivered" | "Sustained telephone silence" | "Telephone audio activity unavailable" };
type Phase = { type: "greeting"; voicemail: boolean } | { type: "conversation" } | { type: "message"; spoken: boolean } | { type: "ended" };

export function voicemailGreeting(text: string): boolean {
  const words = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /\b(voicemail|voice mail|answering machine|leave (?:(?:me|us|your|a|the) ){0,2}(?:message|name)|after the (?:beep|tone)|at the (?:beep|tone)|mailbox|messagerie|boite vocale|repondeur|laiss(?:er|ez|e) (?:votre |un |le )?message|apres (?:le |la )?(?:bip|signal|tonalite))\b/.test(words);
}

export class CallProgress {
  private phase: Phase = { type: "greeting", voicemail: false };
  private inputSeen = false;
  private quietSince: number;
  private lastActivity: number;
  private lastProbe: number;
  private outputQuietSince: number;
  private toneSince: number | null = null;
  private beepEnded: number | null = null;
  private delivered = false;
  private inputText = "";
  constructor(now: number) { this.quietSince = this.lastActivity = this.lastProbe = this.outputQuietSince = now; }

  transcript(delta: string): CallProgressEffect[] {
    if (this.phase.type === "ended" || this.phase.type === "message") return [];
    this.inputText = (this.inputText + delta).slice(-4000);
    if (!voicemailGreeting(this.inputText)) return [];
    if (this.phase.type === "greeting") this.phase.voicemail = true;
    else if (this.delivered) this.phase = { type: "message", spoken: true };
    else { this.phase = { type: "greeting", voicemail: true }; return [{ type: "hold" }]; }
    return [];
  }

  audio(activity: AudioActivity, now: number): CallProgressEffect[] {
    if (this.phase.type === "ended") return [];
    this.lastProbe = now;
    if (activity.input) { this.inputSeen = true; this.quietSince = now; }
    if (activity.input || activity.output) this.lastActivity = now;
    if (activity.output) { this.delivered = true; this.outputQuietSince = now; }
    if (this.phase.type === "greeting") {
      if (activity.tone) this.toneSince ??= now;
      else if (this.toneSince !== null) {
        const duration = now - this.toneSince;
        if (duration >= 120 && duration <= 2000) { this.beepEnded = now; this.phase.voicemail = true; }
        this.toneSince = null;
      }
    } else if (this.phase.type === "message" && activity.output) this.phase.spoken = true;
    return this.tick(now);
  }

  tick(now: number): CallProgressEffect[] {
    if (this.phase.type === "ended") return [];
    if (now - this.lastProbe >= CALL_TIMING.telemetryMs) return this.end("Telephone audio activity unavailable");
    if (this.phase.type === "message" && this.phase.spoken && now - this.outputQuietSince >= CALL_TIMING.messageQuietMs) return this.end("Voicemail message delivered");
    if (now - this.lastActivity >= CALL_TIMING.silenceMs) return this.end("Sustained telephone silence");
    if (this.phase.type !== "greeting") return [];
    const quietMs = now - this.quietSince;
    const endedBeep = this.beepEnded !== null && this.toneSince === null && now - this.beepEnded >= CALL_TIMING.beepQuietMs && quietMs >= CALL_TIMING.beepQuietMs;
    const greetingEnded = quietMs >= (this.inputSeen || this.phase.voicemail ? CALL_TIMING.greetingQuietMs : CALL_TIMING.initialQuietMs);
    if (!endedBeep && !greetingEnded) return [];
    const voicemail = this.phase.voicemail;
    this.phase = voicemail ? { type: "message", spoken: false } : { type: "conversation" };
    this.outputQuietSince = now;
    return [{ type: "opening", voicemail }];
  }

  private end(reason: Extract<CallProgressEffect, { type: "end" }>["reason"]): CallProgressEffect[] {
    this.phase = { type: "ended" };
    return [{ type: "end", reason }];
  }
}
