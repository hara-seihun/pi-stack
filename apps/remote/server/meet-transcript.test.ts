import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MeetTranscriptStore, transcriptText } from "./meet/transcript";

test("overlapping microphones retain identity, accepted audio survives restart, and final text retires audio", () => {
  const db = new Database(":memory:");
  try {
    const store = new MeetTranscriptStore(db);
    store.create("room", "thread");
    const audio = new Uint8Array([0, 1, 2, 3]);
    expect(store.enqueue("one", "room", "person-a", "Alex", 1000, audio)).toBe(true);
    expect(store.enqueue("two", "room", "person-b", "Alex", 1000, audio)).toBe(true);
    expect(store.enqueue("one", "room", "person-b", "Alex", 1000, audio)).toBe(false);
    store.processing("one");
    const recovered = new MeetTranscriptStore(db);
    recovered.recover();
    expect(recovered.pending()?.id).toBe("one");
    recovered.finish("one", { text: "Hello. Two sentences." });
    recovered.finish("two", { error: "Recognizer unavailable" });
    store.end("room");
    const turns = recovered.read("room");
    expect(turns.map((turn) => turn.speakerId)).toEqual(["person-a", "person-b"]);
    const lines = transcriptText(turns).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Alex [person-a]: Hello. Two sentences.");
    expect(lines[1]).toContain("Alex [person-b]: [failed: Recognizer unavailable] [unfinished]");
    expect(db.query("SELECT audio FROM meet_transcript WHERE id='one'").get()).toEqual({ audio: null });
    expect(db.query("SELECT audio FROM meet_transcript WHERE id='two'").get()).toEqual({ audio });
    recovered.retry("room");
    expect(recovered.pending()?.id).toBe("two");
    expect(recovered.meetings("thread")).toHaveLength(1);
  } finally { db.close(); }
});

test("unfinished Voice text is available for a handoff and cannot overwrite a finalized turn", () => {
  const db = new Database(":memory:");
  try {
    const store = new MeetTranscriptStore(db);
    store.create("room", "thread");
    store.assistant("turn", "room", "The answer is", false, 1000);
    expect(store.read("room")[0]).toMatchObject({ text: "The answer is", final: false, speaker: "Kenan" });
    store.assistant("turn", "room", "The answer is four.", true, 1000);
    store.assistant("turn", "room", "The answer is", false, 1000);
    expect(store.read("room")).toHaveLength(1);
    expect(store.read("room")[0]).toMatchObject({ text: "The answer is four.", final: true });
  } finally { db.close(); }
});
