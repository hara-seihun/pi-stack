import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { callBrief, callInstructions, type CallBrief, type Result } from "./policy";

export type RetellCredentials = { RETELL_API_KEY: string; RETELL_AGENT_ID: string; RETELL_AGENT_VERSION: number; RETELL_FROM_NUMBER: string };
export type RetellDialResult = { ok: true; value: { uuid: string } } | { ok: false; error: string; uncertain: boolean };
export type RetellCallStatus = "registered" | "not_connected" | "ongoing" | "ended" | "error";
export type RetellStatus = "queued" | "unanswered" | "in-progress" | "completed" | "failed";
export type RetellSnapshot = {
  uuid: string;
  call_status: RetellCallStatus;
  status: RetellStatus;
  transcript?: string;
  call_analysis?: Record<string, unknown>;
  call_cost?: Record<string, unknown>;
  duration_ms?: number;
  disconnection_reason?: string;
};
const statuses: Record<RetellCallStatus, RetellStatus> = { registered: "queued", not_connected: "unanswered", ongoing: "in-progress", ended: "completed", error: "failed" };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const idValid = (v: unknown): v is string => typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v);
const nonnegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
export function retellTerminal(status: RetellStatus): boolean { return status === "completed" || status === "failed" || status === "unanswered"; }

function snapshot(value: unknown, expectedId: string): Result<RetellSnapshot> {
  if (!record(value) || value.call_id !== expectedId || typeof value.call_status !== "string" || !Object.hasOwn(statuses, value.call_status)) return { ok: false, error: "Retell returned an invalid call ID or status" };
  for (const key of ["transcript", "disconnection_reason"] as const) if (value[key] !== undefined && typeof value[key] !== "string") return { ok: false, error: `Retell returned invalid ${key}` };
  if (value.duration_ms !== undefined && (!nonnegative(value.duration_ms) || !Number.isInteger(value.duration_ms))) return { ok: false, error: "Retell returned invalid duration_ms" };
  if (value.call_analysis !== undefined && !record(value.call_analysis)) return { ok: false, error: "Retell returned invalid call_analysis" };
  if (value.call_cost !== undefined) {
    const cost = value.call_cost;
    if (!record(cost) || !["total_duration_seconds", "total_duration_unit_price", "combined_cost"].every(k => nonnegative(cost[k])) || !Array.isArray(cost.product_costs) || cost.product_costs.some(p => !record(p) || typeof p.product !== "string" || (p.unit_price !== undefined && !nonnegative(p.unit_price)) || !nonnegative(p.cost) || (p.is_transfer_leg_cost !== undefined && typeof p.is_transfer_leg_cost !== "boolean"))) return { ok: false, error: "Retell returned invalid call_cost" };
  }
  const call_status = value.call_status as RetellCallStatus;
  return { ok: true, value: {
    uuid: expectedId, call_status, status: statuses[call_status],
    ...(value.transcript === undefined ? {} : { transcript: value.transcript as string }),
    ...(value.disconnection_reason === undefined ? {} : { disconnection_reason: value.disconnection_reason as string }),
    ...(value.duration_ms === undefined ? {} : { duration_ms: value.duration_ms as number }),
    ...(value.call_analysis === undefined ? {} : { call_analysis: value.call_analysis as Record<string, unknown> }),
    ...(value.call_cost === undefined ? {} : { call_cost: value.call_cost as Record<string, unknown> }),
  } };
}

export class Retell {
  readonly settings: Readonly<{ callerId: string }>;
  private readonly credentials: RetellCredentials;
  constructor(path: string) {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error();
      const c: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (!record(c) || !["RETELL_API_KEY", "RETELL_AGENT_ID"].every(k => typeof c[k] === "string" && (c[k] as string).trim() === c[k] && (c[k] as string).length > 0 && !/[\r\n]/.test(c[k] as string)) || !Number.isInteger(c.RETELL_AGENT_VERSION) || Number(c.RETELL_AGENT_VERSION) < 0 || typeof c.RETELL_FROM_NUMBER !== "string" || !/^\+[1-9]\d{6,14}$/.test(c.RETELL_FROM_NUMBER)) throw new Error();
      this.credentials = { RETELL_API_KEY: c.RETELL_API_KEY as string, RETELL_AGENT_ID: c.RETELL_AGENT_ID as string, RETELL_AGENT_VERSION: c.RETELL_AGENT_VERSION as number, RETELL_FROM_NUMBER: c.RETELL_FROM_NUMBER };
      this.settings = Object.freeze({ callerId: this.credentials.RETELL_FROM_NUMBER });
    } catch { throw new Error("Valid Retell credentials, explicit agent version and E.164 caller number in a 0600 file are required"); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  private async request(path: string, method: "GET" | "POST", body?: unknown): Promise<{ ok: true; value: unknown; status: number } | { ok: false; error: string; uncertain: boolean }> {
    try {
      const response = await fetch(`https://api.retellai.com${path}`, {
        method, headers: { authorization: `Bearer ${this.credentials.RETELL_API_KEY}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000), redirect: "error",
      });
      if (!response.ok) return { ok: false, error: `Retell HTTP ${response.status}: request failed`, uncertain: response.status >= 500 || response.status === 408 };
      return { ok: true, value: response.status === 204 ? null : await response.json(), status: response.status };
    } catch { return { ok: false, error: "Retell request failed or returned invalid JSON; outcome unknown", uncertain: true }; }
  }
  async dial(brief: CallBrief, localId: string): Promise<RetellDialResult> {
    const approved = callBrief(brief);
    if (!approved.ok) return { ...approved, uncertain: false };
    if (!idValid(localId)) return { ok: false, error: "A bounded local call ID is required", uncertain: false };
    const seconds = approved.value.maxSeconds === undefined ? 300 : approved.value.maxSeconds;
    if (seconds < 60) return { ok: false, error: "Retell calls require at least 60 seconds", uncertain: false };
    const result = await this.request("/v2/create-phone-call", "POST", {
      from_number: this.settings.callerId, to_number: approved.value.to,
      override_agent_id: this.credentials.RETELL_AGENT_ID, override_agent_version: this.credentials.RETELL_AGENT_VERSION,
      metadata: { local_call_id: localId },
      retell_llm_dynamic_variables: { approved_call_prompt: callInstructions(approved.value), approved_opening: approved.value.opening },
      agent_override: { agent: { max_call_duration_ms: Math.min(seconds, 600) * 1000 }, retell_llm: { start_speaker: "agent", begin_message: approved.value.opening, knowledge_base_ids: [] } },
    });
    if (!result.ok) return result;
    if (!record(result.value) || !idValid(result.value.call_id)) return { ok: false, error: "Retell dial accepted without a valid call ID; outcome unknown", uncertain: true };
    return { ok: true, value: { uuid: result.value.call_id } };
  }
  async get(id: string): Promise<Result<RetellSnapshot>> {
    if (!idValid(id)) return { ok: false, error: "A bounded Retell call ID is required" };
    const result = await this.request(`/v2/get-call/${encodeURIComponent(id)}`, "GET");
    if (!result.ok) return result;
    return snapshot(result.value, id);
  }
  async hangup(id: string): Promise<Result<{ ended: true }>> {
    if (!idValid(id)) return { ok: false, error: "A bounded Retell call ID is required" };
    const result = await this.request(`/v2/stop-call/${encodeURIComponent(id)}`, "POST");
    if (result.ok && result.status === 204) return { ok: true, value: { ended: true } };
    const current = await this.get(id);
    if (current.ok && retellTerminal(current.value.status)) return { ok: true, value: { ended: true } };
    return { ok: false, error: result.ok ? "Retell stop returned an unexpected response; outcome unknown" : result.error };
  }
}
