import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ensureSupervisorSchema } from "../database";
import { meetingHandoffText, prepareMeetingHandoff } from "./handoff";
import { MeetTranscriptStore } from "./transcript";

test("each thread receives the full missing transcript; queued copies do not count as delivered", async () => {
  const db = new Database(":memory:");
  ensureSupervisorSchema(db);
  const transcript = new MeetTranscriptStore(db);
  // What each thread's own context holds, which is how a turn counts as
  // delivered when no annotation carried it.
  const context = new Map<string, Array<{ text: string; time: number }>>();
  const history = {
    receipts(sessionId: string) {
      return (db.query("SELECT meeting_transcript,created_at FROM message_annotations WHERE session_id=? ORDER BY created_at")
        .all(sessionId) as Array<{ meeting_transcript: string; created_at: string | null }>)
        .map(row => ({ transcript: row.meeting_transcript, time: row.created_at ?? "" }));
    },
    messages(sessionId: string) { return context.get(sessionId) ?? []; },
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
    const first = await prepareMeetingHandoff(db, transcript, "room", "a", history);
    expect(first.map((turn) => turn.id)).toEqual(["first", "second"]);
    db.query("INSERT INTO message_annotations(work_id,session_id,created_at,meeting_transcript) VALUES('work','a','1',?)")
      .run(JSON.stringify(first));
    // Attaching the transcript to a message is not delivery: until that message
    // is in the thread's context, the same turns are still missing.
    expect(await prepareMeetingHandoff(db, transcript, "room", "a", history)).toEqual(first);
    context.set("a", [{ text: `task\n${meetingHandoffText(first)}`, time: 10 }]);
    expect(await prepareMeetingHandoff(db, transcript, "room", "a", history)).toEqual([]);
    expect((await prepareMeetingHandoff(db, transcript, "room", "b", history)).map((turn) => turn.id)).toEqual(["first", "second"]);
    utterance("latest", "And show the tools.", 3);
    expect((await prepareMeetingHandoff(db, transcript, "room", "a", history)).map((turn) => turn.id)).toEqual(["latest"]);
    transcript.finish("second", { text: "Make it a square video." });
    const changed = await prepareMeetingHandoff(db, transcript, "room", "a", history);
    expect(meetingHandoffText(changed)).toContain("Hara corrected: Make it a square video.");
    expect(meetingHandoffText(changed)).toContain("Hara: And show the tools.");
  } finally { db.close(); }
});
