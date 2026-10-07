import { assertNever } from "../../shared/explicit-state";

export type VoiceState = "idle" | "connecting" | "live" | "closing" | "error";
export const VOICE_STATES = { idle: true, connecting: true, live: true, closing: true, error: true } satisfies Record<VoiceState, true>;

export function voiceActionLabel(state: VoiceState): string {
  switch (state) {
    case "idle": return "Start voice";
    case "connecting": return "Connecting voice…";
    case "live": return "Hang up voice";
    case "closing": return "Ending voice…";
    case "error": return "Retry voice";
  }
  return assertNever(state, "Voice action");
}
