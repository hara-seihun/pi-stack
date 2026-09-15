import type { Database } from "bun:sqlite";
import type { MeetThreadState } from "./protocol";

type LiveActivity = Pick<MeetThreadState, "state" | "tools" | "output">;
const preview = (value: unknown, limit = 2400): string => {
  const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value, null, 2);
  return text.length > limit ? `${text.slice(0, limit)}\n… continued in thread` : text;
};

export function meetingActivity(db: Database, rows: Array<{ id: string; name: string; last_error?: string | null }>, rootId: string, live: (row: any) => LiveActivity): MeetThreadState[] {
  return rows.map((row) => {
    const activity = live(row);
    const records = db.query(`SELECT seq,type,payload FROM events WHERE session_id=?
      AND type IN ('tool_start','tool_end','assistant','notice') ORDER BY seq DESC LIMIT 8`).all(row.id) as Array<{ seq: number; type: string; payload: string }>;
    const events = records.reverse().map((record) => {
      const value = JSON.parse(record.payload);
      return {
        id: record.seq,
        kind: record.type === "tool_end" && value.error ? "tool_error" : record.type,
        name: String(value.name || (record.type === "assistant" ? "Kenan" : "Status")),
        text: preview(record.type === "tool_start" ? value.args : record.type === "tool_end" ? value.output : value.text),
      };
    });
    return {
      id: String(row.id), name: row.id === rootId ? "Meeting thread" : String(row.name),
      state: activity.state, tools: activity.tools,
      output: preview(row.last_error || activity.output || [...events].reverse().find((event) => event.kind === "assistant")?.text || ""),
      events,
    };
  });
}
