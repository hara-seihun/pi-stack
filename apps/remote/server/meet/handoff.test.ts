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
    for (const id of ["a", "b"]) db.query(`INSERT INTO sessions(id,name,workspace_id,state,created_at,updated_at,profile_id)
      VALUES(?,?,?,'IDLE','','','home')`).run(id, id, "home");
    transcript.create("room", "a");
    const utterance = (id: string, text: string, at: number) => {
      transcript.enqueue(id, "room", "hara", "Hara", at, new Uint8Array([0, 0]));
      transcript.finish(id, { text });
    };
    utterance("first", "Build the page.", 1);
    utterance("second", "Make it square.", 2);
    const first = await prepareMeetingHandoff(db, transcript, "room", "a");
    expect(first.map((turn) => turn.id)).toEqual(["first", "second"]);
    db.query(`INSERT INTO work_items(id,session_id,request_id,event_seq,text,state,available_at,created_at,updated_at,meeting_transcript)
      VALUES('work','a','request',0,'task','queued',0,'','',?)`).run(JSON.stringify(first));
    expect(await prepareMeetingHandoff(db, transcript, "room", "a")).toEqual(first);
    const inserted = db.query("INSERT INTO events(session_id,time,type,payload) VALUES('a','','user',?)")
      .run(JSON.stringify({ text: `task\n${meetingHandoffText(first)}` }));
    db.query("UPDATE work_items SET inserted_at='now',event_seq=? WHERE id='work'").run(inserted.lastInsertRowid);
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
