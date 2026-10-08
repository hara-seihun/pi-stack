import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ensureSupervisorSchema } from "../database";
import { meetingHandoffText, prepareMeetingHandoff } from "./handoff";
import { MeetTranscriptStore } from "./transcript";

test("only exact owner landing receipts deliver a handoff; replay and corrected turns preserve identities", async () => {
  const db = new Database(":memory:");
  ensureSupervisorSchema(db);
  const transcript = new MeetTranscriptStore(db);
  const landed = new Set<string>();
  const history = {
    async *receipts(sessionId: string) {
      const rows = db.query("SELECT work_id,meeting_transcript FROM message_annotations WHERE session_id=? ORDER BY rowid")
        .all(sessionId) as Array<{ work_id: string; meeting_transcript: string }>;
      for (const row of rows) yield { transcript: row.meeting_transcript, delivered: landed.has(row.work_id) };
    },
  };
  try {
    for (const id of ["a", "b"]) db.query("INSERT INTO thread_views(id) VALUES(?)").run(id);
    transcript.create("room", "a");
    const utterance = (id: string, text: string, at: number) => {
      transcript.enqueue(id, "room", "hara", "Hara", at, new Uint8Array([0, 0]));
      transcript.finish(id, { text });
    };
    utterance("first", "Build the page.", 1);
    utterance("second", "Make it square.", 2);
    const first = await prepareMeetingHandoff(transcript, "room", "a", history);
    expect(first.map(turn => turn.id)).toEqual(["first", "second"]);
    db.query("INSERT INTO message_annotations(work_id,session_id,meeting_transcript) VALUES('work','a',?)").run(JSON.stringify(first));
    expect(await prepareMeetingHandoff(transcript, "room", "a", history)).toEqual(first);
    landed.add("work");
    expect(await prepareMeetingHandoff(transcript, "room", "a", history)).toEqual([]);
    expect((await prepareMeetingHandoff(transcript, "room", "b", history)).map(turn => turn.id)).toEqual(["first", "second"]);
    utterance("latest", "And show the tools.", 3);
    transcript.finish("second", { text: "Make it a square video." });
    const changed = await prepareMeetingHandoff(transcript, "room", "a", history);
    expect(meetingHandoffText(changed)).toContain("Hara corrected: Make it a square video.");
    expect(meetingHandoffText(changed)).toContain("Hara: And show the tools.");
  } finally { db.close(); }
});
