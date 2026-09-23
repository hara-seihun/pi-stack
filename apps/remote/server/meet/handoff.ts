import type { Database } from "bun:sqlite";
import type { MeetTranscriptStore } from "./transcript";

type DeliveredTurn = { id: string; speaker: string; text: string; previous: string | null };

export function meetingHandoffText(turns: DeliveredTurn[]): string {
  if (!turns.length) return "";
  return "Meeting transcript not yet in this thread:\n" + turns.map((turn) => {
    const continued = turn.previous !== null && turn.text.startsWith(turn.previous);
    const text = continued ? turn.text.slice(turn.previous!.length).trim() : turn.text.trim();
    return `${turn.speaker}${continued ? " continued" : turn.previous !== null ? " corrected" : ""}: ${text}`;
  }).join("\n");
}

/** What this thread has already been told, and when. Delivery receipts live
 * with the message that carried them; the thread's own context is the record
 * of what it actually received. */
export interface HandoffHistory {
  receipts(sessionId: string): Array<{ transcript: string | null; time: string }>;
  messages(sessionId: string): Array<{ text: string; time: number }>;
}

export async function prepareMeetingHandoff(db: Database, transcripts: MeetTranscriptStore, meetingId: string, sessionId: string, history?: HandoffHistory): Promise<DeliveredTurn[]> {
  const cutoff = Date.now();
  const deadline = cutoff + 35_000;
  let turns = transcripts.read(meetingId).filter((turn) => turn.startedAt <= cutoff);
  while (turns.some((turn) => turn.status === "queued" || turn.status === "processing")) {
    if (Date.now() >= deadline) throw new Error("Meeting transcription is still processing; the delegation is waiting for its transcript");
    await new Promise((resolve) => setTimeout(resolve, 250));
    turns = transcripts.read(meetingId).filter((turn) => turn.startedAt <= cutoff);
  }
  const failed = turns.find((turn) => turn.status === "failed");
  if (failed) throw new Error(`Meeting transcript needs recovery: ${failed.speaker}: ${failed.error}`);
  const source = history ?? storedHandoffHistory(db);
  const received = source.messages(sessionId);
  const delivered = new Map<string, string>();
  // Attaching a transcript to a message is not delivery: the message can sit in
  // the queue or fail. A receipt counts once the block it produced is in the
  // thread's own context.
  for (const receipt of source.receipts(sessionId)) {
    const turns = JSON.parse(receipt.transcript ?? "[]") as DeliveredTurn[];
    if (!turns.length) continue;
    const block = meetingHandoffText(turns);
    if (!received.some((message) => message.text.includes(block))) continue;
    for (const turn of turns) delivered.set(turn.id, turn.text);
  }
  const existingMessages = received.filter((message) =>
    message.text.includes("Meeting transcript not yet in this thread:") || message.text.includes("Conversation since the last handoff:"));
  for (const turn of turns) if (!delivered.has(turn.id) && turn.text.trim()
    && existingMessages.some((message) => turn.startedAt <= message.time && message.text.includes(`${turn.speaker}: ${turn.text.trim()}`))) delivered.set(turn.id, turn.text);
  return turns.filter((turn) => turn.text.trim() && delivered.get(turn.id) !== turn.text)
    .map((turn) => ({ id: turn.id, speaker: turn.speaker, text: turn.text, previous: delivered.get(turn.id) ?? null }));
}

/** The default history: annotations for the receipts, and the supervisor's own
 * record of user messages for the fallback match. */
function storedHandoffHistory(db: Database): HandoffHistory {
  return {
    receipts(sessionId) {
      return (db.query("SELECT meeting_transcript,created_at FROM message_annotations WHERE session_id=? ORDER BY created_at")
        .all(sessionId) as Array<{ meeting_transcript: string; created_at: string | null }>)
        .map((row) => ({ transcript: row.meeting_transcript, time: row.created_at ?? "" }));
    },
    messages() { return []; },
  };
}
