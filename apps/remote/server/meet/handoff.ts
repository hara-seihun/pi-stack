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

export async function prepareMeetingHandoff(db: Database, transcripts: MeetTranscriptStore, meetingId: string, sessionId: string): Promise<DeliveredTurn[]> {
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
  const delivered = new Map<string, string>();
  const receipts = db.query(`SELECT w.meeting_transcript,e.payload,e.time FROM events e LEFT JOIN work_items w
    ON w.event_seq=e.seq AND w.session_id=e.session_id AND w.inserted_at IS NOT NULL
    WHERE e.session_id=? AND e.type='user' ORDER BY e.seq`).all(sessionId) as Array<{ meeting_transcript: string | null; payload: string; time: string }>;
  const existingMessages: Array<{ text: string; time: number }> = [];
  for (const receipt of receipts) {
    for (const turn of JSON.parse(receipt.meeting_transcript ?? "[]") as DeliveredTurn[]) delivered.set(turn.id, turn.text);
    const text = String(JSON.parse(receipt.payload).text ?? "");
    if (text.includes("Meeting transcript not yet in this thread:") || text.includes("Conversation since the last handoff:")) {
      existingMessages.push({ text, time: Date.parse(receipt.time) });
    }
  }
  for (const turn of turns) if (!delivered.has(turn.id) && turn.text.trim()
    && existingMessages.some((message) => turn.startedAt <= message.time && message.text.includes(`${turn.speaker}: ${turn.text.trim()}`))) delivered.set(turn.id, turn.text);
  return turns.filter((turn) => turn.text.trim() && delivered.get(turn.id) !== turn.text)
    .map((turn) => ({ id: turn.id, speaker: turn.speaker, text: turn.text, previous: delivered.get(turn.id) ?? null }));
}
