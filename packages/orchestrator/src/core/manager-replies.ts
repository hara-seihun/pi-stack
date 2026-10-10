import type { DatabaseSync } from "node:sqlite";
import type { Result, WorkOutcome } from "../threads/contracts.js";
import { assistantText, managerLiveText } from "../threads/manager-turn.mjs";

export type ManagerRepliesInput = { after: number | null; limit: number };
export type ManagerReply = { id: string; time: number; text: string; outcome: WorkOutcome };
export type ManagerReplies = { managerThreadId: string; cursor: number; replies: ManagerReply[] };

/** Only the configured manager's completed visible outputs; never arbitrary context or thread selection. */
export function readManagerReplies(db: DatabaseSync, managerThreadId: string, input: ManagerRepliesInput): Result<ManagerReplies> {
  const failure = (code: "invalid_request" | "conflict" | "unavailable", message: string): Result<never> => ({ ok: false, error: { code, message } });
  if (!managerThreadId) return failure("unavailable", "Canonical manager is unset");
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "after" && key !== "limit")
    || !(input.after === null || Number.isSafeInteger(input.after) && input.after >= 0)
    || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) return failure("invalid_request", "Manager replies require an explicit cursor (or null to subscribe at head) and limit 1..100");
  try {
    const head = (db.prepare("SELECT coalesce(max(settlement_seq),0) AS cursor FROM thread_execution WHERE thread_id=?").get(managerThreadId) as { cursor: number }).cursor;
    if (input.after === null) return { ok: true, value: { managerThreadId, cursor: head, replies: [] } };
    if (input.after > head) return failure("conflict", "Manager reply cursor exceeds retained native history");
    const rows = db.prepare("SELECT id,settlement_seq,ended_at,final_message,outcome FROM thread_execution WHERE thread_id=? AND settlement_seq>? ORDER BY settlement_seq LIMIT ?").all(managerThreadId, input.after, input.limit) as { id: string; settlement_seq: number; ended_at: number; final_message: string | null; outcome: WorkOutcome }[];
    const replies: ManagerReply[] = [];
    for (const row of rows) {
      const message = JSON.parse(row.final_message ?? "null");
      // Apply the same manager silent-turn rule as the main UI, strip media tags
      // a phone bubble cannot render, and bound delivery before crossing hosts.
      const visible = managerLiveText(assistantText(message), true).replace(/<pi-remote-[a-z-]+\b[^>]*\/>/g, "").replace(/\n{3,}/g, "\n\n").trim();
      const text = visible || (row.outcome === "failed" ? "That didn't work; the details are in the managing conversation." : "");
      if (text) replies.push({ id: `manager-reply:${managerThreadId}:${row.id}`, time: row.ended_at, text: text.length > 2000 ? `${text.slice(0, 1999)}…` : text, outcome: row.outcome });
    }
    return { ok: true, value: { managerThreadId, cursor: rows.at(-1)?.settlement_seq ?? input.after, replies } };
  } catch (cause) { return failure("unavailable", `Manager reply receipts unavailable: ${cause instanceof Error ? cause.message : String(cause)}`); }
}
