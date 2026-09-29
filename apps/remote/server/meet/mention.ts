import { AGENT_NAME } from "../agent-identity";
import type { MeetTranscriptTurn } from "./protocol";

/** Spellings meeting recognizers produce for "Kenan" (Recall has written "kanon", "keenan" and, most often for a synthetic voice, "kennen"). */
const HEARD_AS = ["keenan", "kennan", "kennen", "kennon", "kenen", "kenon", "kenin", "keenen", "kanan", "kanon", "kinan"];
const NAME = new RegExp(`\\b(?:${[AGENT_NAME.toLowerCase(), ...HEARD_AS].join("|")})\\b`, "i");

/** Whether a line of meeting speech says the agent's name, the cheap signal that someone may be about to talk to it. */
export function addressesAgent(text: string): boolean {
  return NAME.test(text);
}

/** The recent speaker-labelled transcript a freshly opened Voice session did not hear, newest last and bounded for its instructions. */
export function voiceMeetingContext(turns: MeetTranscriptTurn[], now: number, windowMs = 5 * 60_000, maxChars = 4_000): string {
  const lines: string[] = [];
  let size = 0;
  for (const turn of [...turns].reverse()) {
    if (now - turn.startedAt > windowMs) break;
    const text = turn.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const line = `${turn.speaker}: ${text}`;
    if (size + line.length + 1 > maxChars) break;
    lines.unshift(line); size += line.length + 1;
  }
  if (!lines.length) return "";
  return [
    "Meeting transcript from the last few minutes, newest last. Your voice connection opens only while you are unmuted or just after someone says your name, so you did not hear this live.",
    "Pi has already been handed anything in it that was addressed to you. Use it to follow the conversation, and hand work off again only if someone asks again.",
    lines.join("\n"),
  ].join("\n");
}
