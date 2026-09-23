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
    const columns = new Set((db.query("PRAGMA table_info(meet_transcript)").all() as { name: string }[]).map((column) => column.name));
    for (const [name, type] of [["voice_session_id", "TEXT"], ["start_ms", "INTEGER"], ["end_ms", "INTEGER"]]) {
      if (!columns.has(name)) db.exec(`ALTER TABLE meet_transcript ADD COLUMN ${name} ${type}`);
    }
  }
  create(id: string, sessionId: string) { this.db.query("INSERT INTO meet_records(id,session_id,created_at) VALUES(?,?,?)").run(id, sessionId, Date.now()); }
  resume(id: string) { this.db.query("UPDATE meet_records SET ended_at=NULL WHERE id=?").run(id); }
  end(id: string) { this.db.query("UPDATE meet_records SET ended_at=? WHERE id=?").run(Date.now(), id); }
  has(id: string) { return Boolean(this.db.query("SELECT id FROM meet_records WHERE id=?").get(id)); }
  hasSession(sessionId: string) { return Boolean(this.db.query("SELECT 1 FROM meet_records WHERE session_id=? LIMIT 1").get(sessionId)); }
  meetings(sessionId?: string) { return this.db.query("SELECT id,session_id AS sessionId,created_at AS createdAt,ended_at AS endedAt FROM meet_records WHERE (? IS NULL OR session_id=?) ORDER BY created_at DESC LIMIT 100").all(sessionId ?? null, sessionId ?? null); }
  read(id: string): MeetTranscriptTurn[] {
    const records = this.db.query(`SELECT seq,id,speaker_id AS speakerId,speaker,started_at AS startedAt,text,final,status,error,
      voice_session_id AS voiceSessionId,start_ms AS startMs,end_ms AS endMs
      FROM meet_transcript WHERE meeting_id=? AND (text!='' OR status!='done') ORDER BY started_at,seq`).all(id) as Array<MeetTranscriptTurn & {
        seq: number; voiceSessionId: string | null; startMs: number | null; endMs: number | null;
      }>;
    const captions: MeetTranscriptTurn[] = [];
    const active = new Map<string, { caption: MeetTranscriptTurn; end: number; firstSeq: number }>();
    for (const record of records) {
      const { seq, voiceSessionId, startMs, endMs, ...fields } = record;
      const turn = { ...fields, final: Boolean(fields.final) };
      if (!voiceSessionId) { captions.push(turn); continue; }
      const end = turn.startedAt + (startMs !== null && endMs !== null ? endMs - startMs : 0);
      const group = active.get(voiceSessionId);
      if (group && turn.startedAt - group.end <= 1500) {
        group.caption.text += turn.text;
        group.caption.final &&= turn.final;
        group.end = Math.max(group.end, end);
        if (seq < group.firstSeq) { group.firstSeq = seq; group.caption.id = turn.id; }
      } else {
        captions.push(turn);
        active.set(voiceSessionId, { caption: turn, end, firstSeq: seq });
      }
    }
    return captions;
  }
  enqueue(id: string, meeting: string, speakerId: string, speaker: string, startedAt: number, audio: Uint8Array) {
    const existing = this.db.query("SELECT meeting_id,speaker_id FROM meet_transcript WHERE id=?").get(id) as any;
    if (existing) return existing.meeting_id === meeting && existing.speaker_id === speakerId;
    this.db.query("INSERT INTO meet_transcript(id,meeting_id,speaker_id,speaker,started_at,status,audio,updated_at) VALUES(?,?,?,?,?,'queued',?,?)")
      .run(id, meeting, speakerId, speaker, startedAt, audio, Date.now());
    return true;
  }
  assistant(id: string, meeting: string, text: string, final: boolean, startedAt: number,
    fragment?: { voiceSessionId: string; startMs: number; endMs: number }) {
    this.db.query(`INSERT INTO meet_transcript(id,meeting_id,speaker_id,speaker,started_at,text,final,status,updated_at,voice_session_id,start_ms,end_ms)
      VALUES(?,?,'pi','Kenan',?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      text=excluded.text,final=excluded.final,status=excluded.status,updated_at=excluded.updated_at
      WHERE meet_transcript.meeting_id=excluded.meeting_id AND meet_transcript.speaker_id='pi' AND meet_transcript.final=0`)
      .run(id, meeting, startedAt, text, final ? 1 : 0, final ? "done" : "partial", Date.now(),
        fragment?.voiceSessionId ?? null, fragment?.startMs ?? null, fragment?.endMs ?? null);
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
  return turns.map((turn) => {
    const text = turn.text || `[${turn.status}${turn.error ? `: ${turn.error}` : ""}]`;
    return `[${new Date(turn.startedAt).toISOString()}] ${turn.speaker} [${turn.speakerId}]: ${text.replace(/\s*\n\s*/g, " ").trim()}${turn.final ? "" : " [unfinished]"}`;
  }).join("\n") + "\n";
}
