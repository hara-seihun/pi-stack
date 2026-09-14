import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ensureSupervisorSchema } from "../database";
import { meetingHandoffText, prepareMeetingHandoff } from "./handoff";
import { MeetTranscriptStore } from "./transcript";

test("each thread receives the full missing transcript; queued copies do not count as delivered", async () => {
  const db = new Database(":memory:");
  ensureSupervisorSchema(db);
  const transcript = new MeetTranscriptStore(db);
  try {
    for (const id of ["a", "b"]) db.query("INSERT INTO thread_views(id) VALUES(?)").run(id);
    transcript.create("room", "a");
    const utterance = (id: string, text: string, at: number) => {
      transcript.enqueue(id, "room", "hara", "Hara", at, new Uint8Array([0, 0]));
      transcript.finish(id, { text });
    };
    utterance("first", "Build the page.", 1);
    utterance("second", "Make it square.", 2);
    const first = await prepareMeetingHandoff(db, transcript, "room", "a");
    expect(first.map((turn) => turn.id)).toEqual(["first", "second"]);
    db.query("INSERT INTO message_annotations(work_id,meeting_transcript) VALUES('work',?)").run(JSON.stringify(first));
    expect(await prepareMeetingHandoff(db, transcript, "room", "a")).toEqual(first);
    db.query("INSERT INTO events(session_id,time,type,payload) VALUES('a','','user',?)")
      .run(JSON.stringify({ text: `task\n${meetingHandoffText(first)}`, workId: "work" }));
    expect(await prepareMeetingHandoff(db, transcript, "room", "a")).toEqual([]);
    expect((await prepareMeetingHandoff(db, transcript, "room", "b")).map((turn) => turn.id)).toEqual(["first", "second"]);
    utterance("latest", "And show the tools.", 3);
    expect((await prepareMeetingHandoff(db, transcript, "room", "a")).map((turn) => turn.id)).toEqual(["latest"]);
    transcript.finish("second", { text: "Make it a square video." });
    const changed = await prepareMeetingHandoff(db, transcript, "room", "a");
    expect(meetingHandoffText(changed)).toContain("Hara corrected: Make it a square video.");
    expect(meetingHandoffText(changed)).toContain("Hara: And show the tools.");
  } finally { db.close(); }
});
