import type { MeetTranscriptStore } from "./transcript";

type DeliveredTurn = { id: string; speaker: string; text: string; previous: string | null };

export function meetingHandoffText(turns: DeliveredTurn[]): string {
  if (!turns.length) return "";
  return "Meeting transcript not yet in this thread:\n" + turns.map(turn => {
    const continued = turn.previous !== null && turn.text.startsWith(turn.previous);
    const text = continued ? turn.text.slice(turn.previous!.length).trim() : turn.text.trim();
    return `${turn.speaker}${continued ? " continued" : turn.previous !== null ? " corrected" : ""}: ${text}`;
  }).join("\n");
}

export interface HandoffHistory {
  receipts(sessionId: string): AsyncIterable<{ transcript: string; delivered: boolean }>;
}

export async function prepareMeetingHandoff(transcripts: MeetTranscriptStore, meetingId: string, sessionId: string,
  history: HandoffHistory): Promise<DeliveredTurn[]> {
  const cutoff = Date.now();
  const deadline = cutoff + 35_000;
  let turns = transcripts.read(meetingId).filter(turn => turn.startedAt <= cutoff);
  while (turns.some(turn => turn.status === "queued" || turn.status === "processing")) {
    if (Date.now() >= deadline) throw new Error("Meeting transcription is still processing; the delegation is waiting for its transcript");
    await new Promise(resolve => setTimeout(resolve, 250));
    turns = transcripts.read(meetingId).filter(turn => turn.startedAt <= cutoff);
  }
  const failed = turns.find(turn => turn.status === "failed");
  if (failed) throw new Error(`Meeting transcript needs recovery: ${failed.speaker}: ${failed.error}`);
  const currentIds = new Set(turns.map(turn => turn.id));
  const delivered = new Map<string, string>();
  for await (const receipt of history.receipts(sessionId)) {
    if (!receipt.delivered) continue;
    const attached = JSON.parse(receipt.transcript) as DeliveredTurn[];
    for (const turn of attached) if (currentIds.has(turn.id)) delivered.set(turn.id, turn.text);
  }
  return turns.filter(turn => turn.text.trim() && delivered.get(turn.id) !== turn.text)
    .map(turn => ({ id: turn.id, speaker: turn.speaker, text: turn.text, previous: delivered.get(turn.id) ?? null }));
}
