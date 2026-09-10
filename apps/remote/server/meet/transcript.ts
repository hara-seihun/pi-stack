import { Database } from "bun:sqlite";
import type { MeetTranscriptTurn } from "./protocol";

export class MeetTranscriptStore {
  constructor(readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS meet_records (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS meet_transcript (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      meeting_id TEXT NOT NULL REFERENCES meet_records(id), speaker_id TEXT NOT NULL, speaker TEXT NOT NULL,
      started_at INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '', final INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL, error TEXT, audio BLOB, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS meet_transcript_room ON meet_transcript(meeting_id, started_at, seq);`);
  }
  create(id: string, sessionId: string) { this.db.query("INSERT INTO meet_records(id,session_id,created_at) VALUES(?,?,?)").run(id, sessionId, Date.now()); }
  end(id: string) { this.db.query("UPDATE meet_records SET ended_at=? WHERE id=?").run(Date.now(), id); }
  has(id: string) { return Boolean(this.db.query("SELECT id FROM meet_records WHERE id=?").get(id)); }
  meetings(sessionId: string) { return this.db.query("SELECT id,created_at AS createdAt,ended_at AS endedAt FROM meet_records WHERE session_id=? ORDER BY created_at DESC").all(sessionId); }
  read(id: string): MeetTranscriptTurn[] {
    return (this.db.query("SELECT id,speaker_id AS speakerId,speaker,started_at AS startedAt,text,final,status,error FROM meet_transcript WHERE meeting_id=? AND (text!='' OR status!='done') ORDER BY started_at,seq").all(id) as any[])
      .map((turn) => ({ ...turn, final: Boolean(turn.final) }));
  }
  enqueue(id: string, meeting: string, speakerId: string, speaker: string, startedAt: number, audio: Uint8Array) {
    const existing = this.db.query("SELECT meeting_id,speaker_id FROM meet_transcript WHERE id=?").get(id) as any;
    if (existing) return existing.meeting_id === meeting && existing.speaker_id === speakerId;
    this.db.query("INSERT INTO meet_transcript(id,meeting_id,speaker_id,speaker,started_at,status,audio,updated_at) VALUES(?,?,?,?,?,'queued',?,?)")
      .run(id, meeting, speakerId, speaker, startedAt, audio, Date.now());
    return true;
  }
  assistant(id: string, meeting: string, text: string, final: boolean, startedAt: number) {
    this.db.query(`INSERT INTO meet_transcript(id,meeting_id,speaker_id,speaker,started_at,text,final,status,updated_at)
      VALUES(?,?,'pi','Kenan',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      text=excluded.text,final=excluded.final,status=excluded.status,updated_at=excluded.updated_at
      WHERE meet_transcript.meeting_id=excluded.meeting_id AND meet_transcript.speaker_id='pi' AND meet_transcript.final=0`)
      .run(id, meeting, startedAt, text, final ? 1 : 0, final ? "done" : "partial", Date.now());
  }
  recover() { this.db.query("UPDATE meet_transcript SET status='queued' WHERE status='processing'").run(); }
  pending() { return this.db.query("SELECT id,audio FROM meet_transcript WHERE status='queued' ORDER BY seq LIMIT 1").get() as { id: string; audio: Uint8Array } | null; }
  countPending() { return (this.db.query("SELECT count(*) AS n FROM meet_transcript WHERE status IN ('queued','processing')").get() as {n: number}).n; }
  processing(id: string) { this.db.query("UPDATE meet_transcript SET status='processing',updated_at=? WHERE id=?").run(Date.now(), id); }
  finish(id: string, result: { text: string } | { error: string }) {
    if ("text" in result) this.db.query("UPDATE meet_transcript SET text=?,final=1,status='done',error=NULL,audio=NULL,updated_at=? WHERE id=?").run(result.text, Date.now(), id);
    else this.db.query("UPDATE meet_transcript SET status='failed',error=?,updated_at=? WHERE id=?").run(result.error, Date.now(), id);
  }
  retry(meeting: string) { this.db.query("UPDATE meet_transcript SET status='queued',error=NULL WHERE meeting_id=? AND status='failed' AND audio IS NOT NULL").run(meeting); }
}

export function transcriptText(turns: MeetTranscriptTurn[]): string {
  const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });
  return turns.flatMap((turn) => [...sentences.segment(turn.text || `[${turn.status}${turn.error ? `: ${turn.error}` : ""}]`)].map(({segment}) =>
    `[${new Date(turn.startedAt).toISOString()}] ${turn.speaker} [${turn.speakerId}]: ${segment.trim()}${turn.final ? "" : " [unfinished]"}`,
  )).join("\n") + "\n";
}
