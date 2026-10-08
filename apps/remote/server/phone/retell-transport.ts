import { readFileSync, statSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { callBrief, type CallBrief, type Result } from "./policy";

export type RetellSettings = { apiKey: string; agentId: string; agentVersion: number; callerId: string; silentUrl: string };
export type DialResult = { ok: true; value: { uuid: string } } | { ok: false; error: string; uncertain: boolean };
export type RetellStatus = "queued" | "unanswered" | "in-progress" | "completed" | "failed";
export type RetellSnapshot = { call_id: string; call_status: "registered" | "not_connected" | "ongoing" | "ended" | "error"; status: RetellStatus; disconnection_reason?: string; duration_ms?: number };
export type IceServer = { urls: string | string[]; username?: string; credential?: string };
export type ListenSession = { access_token: string; participant_id: string; transport: "livekit" | "gateway"; url?: string; ice_servers?: IceServer[] };
type RequestResult = { ok: true; value: unknown } | { ok: false; error: string; uncertain: boolean };
const statuses = { registered: "queued", not_connected: "unanswered", ongoing: "in-progress", ended: "completed", error: "failed" } as const;
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const boundedId = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(x);
const secretFile = (path: string): string => {
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Owner-only credential file required");
  return readFileSync(path, "utf8");
};
export function retellCredentials(value: unknown, silentUrl: string): Result<RetellSettings> {
  const fields = ["RETELL_API_KEY", "RETELL_AGENT_ID", "RETELL_AGENT_VERSION", "RETELL_FROM_NUMBER"];
  if (!record(value) || Object.keys(value).some(k => !fields.includes(k)) || typeof value.RETELL_API_KEY !== "string" || !value.RETELL_API_KEY.trim() || !boundedId(value.RETELL_AGENT_ID) || !Number.isSafeInteger(value.RETELL_AGENT_VERSION) || Number(value.RETELL_AGENT_VERSION) < 0 || typeof value.RETELL_FROM_NUMBER !== "string" || !/^\+[1-9]\d{7,14}$/.test(value.RETELL_FROM_NUMBER)) return { ok: false, error: "Retell credentials require API key, agent ID, explicit immutable version and E.164 caller number" };
  try {
    const url = new URL(silentUrl);
    if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash || !/^\/retell\/silent\/[a-f0-9]{64}$/.test(url.pathname)) return { ok: false, error: "An authenticated silent WebSocket URL is required" };
  } catch { return { ok: false, error: "An authenticated silent WebSocket URL is required" }; }
  return { ok: true, value: { apiKey: value.RETELL_API_KEY, agentId: value.RETELL_AGENT_ID, agentVersion: Number(value.RETELL_AGENT_VERSION), callerId: value.RETELL_FROM_NUMBER, silentUrl } };
}
export function silentUrl(base: string, tokenFile: string): Result<string> {
  try {
    const url = new URL(base), token = secretFile(tokenFile).trim();
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "") || !/^[a-f0-9]{64}$/.test(token)) return { ok: false, error: "Public HTTPS origin and an owner-only 256-bit silent token are required" };
    return { ok: true, value: `${url.origin.replace(/^https:/, "wss:")}/retell/silent/${token}` };
  } catch { return { ok: false, error: "Silent callback configuration could not be loaded" }; }
}
export function silentAuthorized(actualToken: string, expectedToken: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(actualToken) || !/^[a-f0-9]{64}$/.test(expectedToken)) return false;
  return timingSafeEqual(Buffer.from(actualToken), Buffer.from(expectedToken));
}
export type SilentResponse = { response_type: "response"; response_id: number; content: ""; content_complete: true } | { response_type: "ping_pong"; timestamp: number };
export function silentBegin(): [{ response_type: "config"; config: { auto_reconnect: true; call_details: false } }, SilentResponse] {
  return [{ response_type: "config", config: { auto_reconnect: true, call_details: false } }, { response_type: "response", response_id: 0, content: "", content_complete: true }];
}
export function silentReply(value: unknown): Result<SilentResponse | null> {
  if (!record(value)) return { ok: false, error: "Silent transport requires a protocol event object" };
  switch (value.interaction_type) {
    case "ping_pong":
      if (!Number.isSafeInteger(value.timestamp) || Number(value.timestamp) < 0) return { ok: false, error: "Invalid silent heartbeat" };
      return { ok: true, value: { response_type: "ping_pong", timestamp: Number(value.timestamp) } };
    case "response_required": case "reminder_required":
      if (!Number.isSafeInteger(value.response_id) || Number(value.response_id) < 0) return { ok: false, error: "Invalid silent response ID" };
      return { ok: true, value: { response_type: "response", response_id: Number(value.response_id), content: "", content_complete: true } };
    case "update_only":
      if (!Array.isArray(value.transcript)) return { ok: false, error: "Invalid silent transcript event" };
      return { ok: true, value: null };
    default: return { ok: false, error: "Unknown silent transport event" };
  }
}
export function silentAgent(settings: RetellSettings): Record<string, unknown> {
  return { agent_name: "Kenan GPT Live silent carrier", response_engine: { type: "custom-llm", llm_websocket_url: settings.silentUrl }, voice_id: "retell-Cimo", ambient_sound: null, enable_backchannel: false, reminder_max_count: 0, voicemail_option: null, ivr_option: null, contact_memory_config: { enable_read: false, enable_write: false }, max_call_duration_ms: 600_000, data_storage_setting: "basic_attributes_only" };
}
export function verifiedSilentAgent(value: unknown, settings: RetellSettings): boolean {
  return record(value) && value.agent_id === settings.agentId && value.version === settings.agentVersion && value.is_published === true && record(value.response_engine) && value.response_engine.type === "custom-llm" && value.response_engine.llm_websocket_url === settings.silentUrl && value.ambient_sound === null && value.enable_backchannel === false && value.reminder_max_count === 0 && value.voicemail_option === null && value.ivr_option === null && record(value.contact_memory_config) && value.contact_memory_config.enable_read === false && value.contact_memory_config.enable_write === false;
}
export function retellTerminal(status: RetellStatus): boolean { return status === "unanswered" || status === "completed" || status === "failed"; }
export class RetellTakeover {
  readonly settings: RetellSettings;
  constructor(path: string, expectedSilentUrl: string) {
    const parsed = retellCredentials(JSON.parse(secretFile(path)), expectedSilentUrl);
    if (!parsed.ok) throw new Error(parsed.error);
    this.settings = parsed.value;
  }
  private async request(path: string, method: "GET" | "POST", body?: unknown): Promise<RequestResult> {
    try {
      const response = await fetch(`https://api.retellai.com${path}`, { method, headers: { authorization: `Bearer ${this.settings.apiKey}`, "content-type": "application/json", "X-Retell-Client-JS-SDK-Version": "3.0.2" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000), redirect: "error" });
      if (!response.ok) return { ok: false, error: `Retell HTTP ${response.status}`, uncertain: response.status >= 500 || response.status === 408 };
      const text = await response.text();
      return { ok: true, value: text === "" ? null : JSON.parse(text) };
    } catch { return { ok: false, error: "Retell request outcome unknown", uncertain: true }; }
  }
  async verify(): Promise<Result<{ agentId: string; agentVersion: number; callerId: string }>> {
    const s = this.settings;
    const [agent, number] = await Promise.all([this.request(`/get-agent/${encodeURIComponent(s.agentId)}?version=${s.agentVersion}`, "GET"), this.request(`/get-phone-number/${encodeURIComponent(s.callerId)}`, "GET")]);
    if (!agent.ok) return agent;
    if (!number.ok) return number;
    if (!verifiedSilentAgent(agent.value, s)) return { ok: false, error: "Pinned Retell agent is not the verified deterministic silent custom transport" };
    if (!record(number.value) || number.value.phone_number !== s.callerId || number.value.phone_number_type !== "retell-twilio") return { ok: false, error: "Retell caller number ownership or managed carrier does not match" };
    return { ok: true, value: { agentId: s.agentId, agentVersion: s.agentVersion, callerId: s.callerId } };
  }
  async dial(brief: CallBrief, id: string): Promise<DialResult> {
    const parsed = callBrief(brief);
    if (!parsed.ok || !boundedId(id) || brief.maxSeconds < 60) return { ok: false, error: parsed.ok ? "A bounded local call ID and 60–1800 second call duration are required" : parsed.error, uncertain: false };
    const verified = await this.verify();
    if (!verified.ok) return { ...verified, uncertain: false };
    const s = this.settings;
    const result = await this.request("/v2/create-phone-call", "POST", { from_number: s.callerId, to_number: brief.to, override_agent_id: s.agentId, override_agent_version: s.agentVersion, idempotency_key: id, agent_override: { agent: { max_call_duration_ms: brief.maxSeconds * 1000 } }, metadata: { local_call_id: id, approved_request_id: brief.requestId } });
    if (!result.ok) return result;
    if (!record(result.value) || !boundedId(result.value.call_id)) return { ok: false, error: "Retell accepted dial without a call ID; outcome unknown", uncertain: true };
    return { ok: true, value: { uuid: result.value.call_id } };
  }
  async get(id: string): Promise<Result<RetellSnapshot>> {
    if (!boundedId(id)) return { ok: false, error: "A bounded Retell call ID is required" };
    const result = await this.request(`/v2/get-call/${encodeURIComponent(id)}`, "GET");
    if (!result.ok) return result;
    const c = result.value;
    if (!record(c) || c.call_id !== id || typeof c.call_status !== "string" || !Object.hasOwn(statuses, c.call_status) || (c.disconnection_reason !== undefined && typeof c.disconnection_reason !== "string") || (c.duration_ms !== undefined && (!Number.isSafeInteger(c.duration_ms) || Number(c.duration_ms) < 0))) return { ok: false, error: "Invalid Retell call snapshot" };
    const call_status = c.call_status as RetellSnapshot["call_status"];
    return { ok: true, value: { call_id: id, call_status, status: statuses[call_status], ...(c.disconnection_reason === undefined ? {} : { disconnection_reason: c.disconnection_reason as string }), ...(c.duration_ms === undefined ? {} : { duration_ms: c.duration_ms as number }) } };
  }
  async hangup(id: string): Promise<Result<unknown>> {
    if (!boundedId(id)) return { ok: false, error: "A bounded Retell call ID is required" };
    const result = await this.request(`/v2/stop-call/${encodeURIComponent(id)}`, "POST");
    if (result.ok) return { ok: true, value: { stopped: true } };
    const current = await this.get(id);
    if (current.ok && retellTerminal(current.value.status) && current.value.disconnection_reason !== "call_take_over") return { ok: true, value: { stopped: true } };
    return result;
  }
  async listen(id: string): Promise<Result<ListenSession>> {
    if (!boundedId(id)) return { ok: false, error: "A bounded Retell call ID is required" };
    const result = await this.request(`/v2/listen-live-call/${encodeURIComponent(id)}`, "POST", {});
    if (!result.ok) return result;
    const c = result.value;
    if (!record(c) || typeof c.access_token !== "string" || !c.access_token || c.access_token.length > 16_384 || !boundedId(c.participant_id) || (c.transport !== "livekit" && c.transport !== "gateway")) return { ok: false, error: "Invalid Retell media session" };
    if (c.url !== undefined) {
      try { const u = new URL(String(c.url)); if (typeof c.url !== "string" || u.protocol !== "wss:" || u.username || u.password || u.hash) return { ok: false, error: "Invalid Retell media URL" }; }
      catch { return { ok: false, error: "Invalid Retell media URL" }; }
    }
    if (c.ice_servers !== undefined && (!Array.isArray(c.ice_servers) || c.ice_servers.some(s => !record(s) || !(typeof s.urls === "string" || (Array.isArray(s.urls) && s.urls.length > 0 && s.urls.every(u => typeof u === "string"))) || (s.username !== undefined && typeof s.username !== "string") || (s.credential !== undefined && typeof s.credential !== "string")))) return { ok: false, error: "Invalid Retell ICE server configuration" };
    return { ok: true, value: { access_token: c.access_token, participant_id: c.participant_id, transport: c.transport, ...(c.url === undefined ? {} : { url: c.url as string }), ...(c.ice_servers === undefined ? {} : { ice_servers: c.ice_servers as IceServer[] }) } };
  }
  async takeOver(id: string, participantId: string): Promise<Result<unknown>> {
    if (!boundedId(id) || !boundedId(participantId)) return { ok: false, error: "A bounded Retell call and participant ID are required" };
    return this.request(`/v2/take-over-live-call/${encodeURIComponent(id)}`, "POST", { participant_id: participantId });
  }
}
