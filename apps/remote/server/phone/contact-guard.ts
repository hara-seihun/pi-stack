import type { Database } from "bun:sqlite";
import { closeSync, fstatSync, openSync, readFileSync, constants } from "node:fs";
import type { CallBrief } from "./policy";

const cooldownMs = 2 * 60 * 60 * 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const e164 = /^\+[1-9][0-9]{7,14}$/;
type Refusal = { ok: false; code: "recipient-held" | "recipient-busy" | "recipient-dial-uncertain" | "recipient-cooldown" | "contact-policy-unavailable"; error: string; callId?: string; retryAt?: number };
type Result = { ok: true } | Refusal;
type Config = { holdsFile?: unknown; followUpApprovalsFile?: unknown };
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function file(path: unknown, operatorOwned: boolean): Record<string, unknown> {
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error("Policy file must be an absolute path");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024 || operatorOwned && (stat.uid !== 0 || (stat.mode & 0o022) !== 0)) throw new Error("Policy file ownership or shape invalid");
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!record(value)) throw new Error("Policy must be a JSON object");
    return value;
  } finally { closeSync(fd); }
}

/** Synchronous with call reservation: no await may separate this check from INSERT. */
export function contactGuard(db: Database, brief: CallBrief, config: Config, now: number, readPolicy: typeof file = file): Result {
  try {
    if (config.holdsFile !== undefined) {
      const holds = readPolicy(config.holdsFile, false);
      if (Object.entries(holds).some(([number, reason]) => !e164.test(number) || typeof reason !== "string" || !reason.trim())) throw new Error("Invalid recipient hold");
      if (Object.hasOwn(holds, brief.to)) return { ok: false, code: "recipient-held", error: holds[brief.to] as string };
    }
    const unfinished = db.query("SELECT id FROM calls WHERE json_extract(brief,'$.to')=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1").get(brief.to) as { id: string } | null;
    if (unfinished) return { ok: false, code: "recipient-busy", error: "A call to this recipient is unfinished", callId: unfinished.id };
    const uncertain = db.query("SELECT id FROM calls WHERE json_extract(brief,'$.to')=? AND dial_state IN ('dispatching','uncertain') ORDER BY started_at DESC LIMIT 1").get(brief.to) as { id: string } | null;
    if (uncertain) return { ok: false, code: "recipient-dial-uncertain", error: "Prior dial acceptance is uncertain; reconcile its effects before another contact", callId: uncertain.id };
    const prior = db.query("SELECT id,COALESCE(accepted_at,started_at) AS accepted_at,ended_at,cleanup FROM calls WHERE json_extract(brief,'$.to')=? AND dial_state='accepted' ORDER BY COALESCE(accepted_at,started_at) DESC LIMIT 1").get(brief.to) as { id: string; accepted_at: number; ended_at: number | null; cleanup: number } | null;
    if (!prior || prior.accepted_at + cooldownMs <= now) return { ok: true };
    if (brief.followUpOf === prior.id && prior.ended_at !== null && prior.cleanup === 1 && config.followUpApprovalsFile !== undefined) {
      const approvals = readPolicy(config.followUpApprovalsFile, true);
      const approval = approvals[brief.requestId];
      if (approval !== undefined) {
        if (!record(approval) || Object.keys(approval).sort().join(",") !== "followUpOf,reason,reconciledAt,to" || typeof approval.followUpOf !== "string" || !uuid.test(approval.followUpOf) || typeof approval.to !== "string" || !e164.test(approval.to) || typeof approval.reason !== "string" || !approval.reason.trim() || typeof approval.reconciledAt !== "number" || !Number.isSafeInteger(approval.reconciledAt)) throw new Error("Invalid follow-up approval");
        if (approval.followUpOf === prior.id && approval.to === brief.to && approval.reconciledAt >= prior.ended_at && approval.reconciledAt <= now) return { ok: true };
      }
    }
    return { ok: false, code: "recipient-cooldown", error: "Recipient already contacted within two hours; explicit operator reconciliation approval and matching followUpOf are required", callId: prior.id, retryAt: prior.accepted_at + cooldownMs };
  } catch { return { ok: false, code: "contact-policy-unavailable", error: "Recipient policy is unreadable or invalid; no call accepted" }; }
}
