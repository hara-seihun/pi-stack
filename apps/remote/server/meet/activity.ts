import type { MeetThreadState } from "./protocol";

/** The steps a thread has taken recently, newest last. */
export type RecentActivity = (sessionId: string) => Array<{ seq: number; type: string; [key: string]: unknown }>;

type LiveActivity = Pick<MeetThreadState, "state" | "held" | "activity" | "tools" | "output">;
const preview = (value: unknown, limit = 2400): string => {
  const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value, null, 2);
  return text.length > limit ? `${text.slice(0, limit)}\n… continued in thread` : text;
};

export function meetingActivity(recent: RecentActivity, rows: Array<{ id: string; name: string }>, rootId: string, live: (row: any) => LiveActivity): MeetThreadState[] {
  return rows.map((row) => {
    const current = live(row);
    const events = recent(row.id).map((record) => ({
      id: record.seq,
      kind: record.type === "tool_end" && record.error ? "tool_error" : record.type,
      name: String(record.name || (record.type === "assistant" ? "Kenan" : "Status")),
      text: preview(record.type === "tool_start" ? record.args : record.type === "tool_end" ? record.output : record.text),
    }));
    return {
      id: String(row.id), name: row.id === rootId ? "Meeting thread" : String(row.name),
      state: current.state, held: current.held, activity: current.activity, tools: current.tools,
      output: preview(current.output || [...events].reverse().find((event) => event.kind === "assistant")?.text || ""),
      events,
    };
  });
}
