import { Database } from "bun:sqlite";
import { actionJournal, journalWarning } from "kenan-memory/journal";
import { chromium, type Browser, type Page } from "playwright-core";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { callBrief, instructions, type CallBrief } from "./policy";
import { sameToken, type CallFragment } from "./dispatcher";
import { providerSelection, loadProvider } from "./provider";
import { silentReply, silentBegin } from "./retell-transport";
import { contactGuard } from "./contact-guard";
import { ActionStore, type ActionTicket } from "kenan-memory/actions";
import { phoneIntent, reservePhoneAction, settlePhoneAction } from "./action-admission";

const config = JSON.parse(readFileSync(process.env.PI_STACK_PHONE_CONFIG ?? "/etc/pi-stack/phone.json", "utf8"));
const state = process.env.PI_STACK_PHONE_STATE;
if (!state) throw new Error("PI_STACK_PHONE_STATE must select encrypted owner state");
mkdirSync(state, { recursive: true, mode: 0o700 });
const adminToken = readFileSync(config.adminTokenFile, "utf8").trim();
const silentToken = readFileSync(config.silentTokenFile, "utf8").trim();
if (silentToken.length < 32 || sameToken(silentToken, adminToken)) throw new Error("A distinct silent transport capability is required");
const selected = providerSelection(config);
if (!selected.ok) throw new Error(selected.error);
const loaded = loadProvider("retell-takeover", config);
if (!loaded.ok) throw new Error(loaded.error);
const provider = loaded.value;
const owner = config.owner;
const localPort = config.localPort, publicPort = config.publicPort;
const voiceBase = config.voiceUrl, dispatcherBase = config.dispatcherUrl;
if (typeof owner !== "string" || !owner || !Number.isInteger(localPort) || !Number.isInteger(publicPort) || typeof voiceBase !== "string" || typeof dispatcherBase !== "string") throw new Error("Explicit owner, listener ports, Voice and managed dispatcher URLs are required");
const actions = new ActionStore(join(state, "..", ".kenan-actions"), owner);
const db = new Database(join(state, "calls.sqlite3"));
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,provider_id TEXT,voice_id TEXT,status TEXT NOT NULL,brief TEXT NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER,error TEXT,cleanup INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,call_id TEXT NOT NULL,at INTEGER NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL);`);
for (const [name, type] of [["provider_kind", "TEXT"], ["dial_state", "TEXT NOT NULL DEFAULT 'none'"], ["provider_snapshot", "TEXT"], ["accepted_at", "INTEGER"], ["action_id", "TEXT"], ["action_ticket", "TEXT"], ["request_id", "TEXT"], ["dispatcher_closed", "INTEGER NOT NULL DEFAULT 0"]]) {
  if (!(db.query("PRAGMA table_info(calls)").all() as { name: string }[]).some(c => c.name === name)) db.exec(`ALTER TABLE calls ADD COLUMN ${name} ${type}`);
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS call_approved_request ON calls(request_id) WHERE request_id IS NOT NULL");
const json = (v: unknown, status = 200) => Response.json(v, { status });
const error = (message: string, status = 400) => json({ error: message }, status);
const releaseFile = new URL("../../.pi-stack-commit", import.meta.url);
const releaseCommit = existsSync(releaseFile) ? readFileSync(releaseFile, "utf8").trim() : null;
const html = readFileSync(new URL("./media.html", import.meta.url), "utf8");
let browser: Browser | undefined, launching: Promise<Browser> | undefined, stopping = false;
type Row = { id: string; provider_id: string | null; voice_id: string | null; provider_kind: string | null; dial_state: string; dispatcher_closed: number };
type SocketData = { side: "browser"; call?: Call } | { side: "silent"; providerId: string };
type Socket = import("bun").ServerWebSocket<SocketData>;
type Call = { id: string; brief: CallBrief; token: string; actionTicket?: ActionTicket; page?: Page; media?: Socket; voiceId?: string; providerId?: string;
  dialState: "none" | "dispatching" | "accepted" | "uncertain" | "rejected"; timer: ReturnType<typeof setTimeout>;
  ready: Promise<void>; resolveReady: () => void; rejectReady: (e: Error) => void; audio: Promise<void>; resolveAudio: () => void;
  outputBytes: number; usageSeconds: number; offerPending: boolean; transportGranted: boolean; transportNotified: boolean; participantId?: string;
  abort: AbortController; transcript: CallFragment[]; seen: Set<string>; delegations: Set<string>; queue: Promise<void>; finishing?: Promise<void> };
const active = new Map<string, Call>();
const log = (id: string, type: string, payload: unknown) => db.query("INSERT INTO events(call_id,at,type,payload) VALUES(?,?,?,?)").run(id, Date.now(), type, JSON.stringify(payload));
async function request(base: string, path: string, method: string, body: unknown, authenticated = false) {
  try {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${adminToken}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(25_000) });
    const value = await response.json();
    return response.ok ? { ok: true as const, value } : { ok: false as const, error: String(value.error ?? "Service rejected request") };
  } catch { return { ok: false as const, error: "Service acceptance/result unavailable; preserve request identity" }; }
}
const voice = (path: string, method: string, body: unknown) => request(voiceBase, path, method, body);
const dispatch = (id: string, operation: string, body: unknown) => request(dispatcherBase, `/v1/telephone/${id}/${operation}`, "POST", body, true);
const voiceIdentity = (id: string) => ({ owner, threadId: `phone:${id}` });
function snapshot(call: Call): Row { return { id: call.id, provider_id: call.providerId ?? null, voice_id: call.voiceId ?? null, provider_kind: "retell-takeover", dial_state: call.dialState, dispatcher_closed: 0 }; }
async function cleanup(row: Row) {
  const phone = row.provider_id
    ? ["retell", "retell-takeover"].includes(row.provider_kind ?? "") ? await provider.client.hangup(row.provider_id) : { ok: false, error: "Retired provider cleanup requires its account owner" }
    : ["dispatching", "uncertain"].includes(row.dial_state) ? { ok: false, error: "Dial acceptance unknown; provider duration cap applies; never redial" } : { ok: true };
  const spoken = row.voice_id ? await voice(`/sessions/${encodeURIComponent(row.voice_id)}`, "DELETE", voiceIdentity(row.id)) : { ok: true };
  const managed = row.dispatcher_closed === 1 ? { ok: true } : await dispatch(row.id, "close", {});
  if (managed.ok) db.query("UPDATE calls SET dispatcher_closed=1 WHERE id=?").run(row.id);
  const failures = [phone, spoken, managed].filter(r => !r.ok).map(r => "error" in r ? r.error : "Cleanup failed");
  if (failures.length) db.query("UPDATE calls SET cleanup=0,error=? WHERE id=?").run(failures.join("; "), row.id);
  else db.query("UPDATE calls SET cleanup=1 WHERE id=?").run(row.id);
}
function send(call: Call, event: unknown) {
  if (call.finishing || !call.media) return;
  try { if (call.media.send(JSON.stringify({ type: "live-event", event })) === 0) void finish(call, "failed", "Live control backpressure"); }
  catch { void finish(call, "failed", "Live control disconnected"); }
}
function settleAction(call: Call) {
  if (!call.actionTicket) {
    if (call.dialState !== "accepted" || !call.providerId) return;
    const row = db.query("SELECT action_id FROM calls WHERE id=?").get(call.id) as { action_id: string | null } | null;
    if (!row?.action_id) return;
    const existing = actions.inspect(row.action_id);
    if (existing.ok && existing.value.state === "uncertain") {
      const confirmed = actions.reconcile(row.action_id, existing.value.revision, "effect-confirmed", { kind: "provider-receipt", reference: call.providerId, detail: "Late provider acceptance confirms original dial; no new contact" }, "phone-service");
      if (!confirmed.ok) log(call.id, "action-settlement-pending", { error: confirmed.error });
    }
    return;
  }
  const result = settlePhoneAction(actions, call.actionTicket, call.id, call.dialState, call.providerId ?? null);
  if (!result.ok) { log(call.id, "action-settlement-pending", { error: result.error }); return; }
  db.query("UPDATE calls SET action_ticket=NULL WHERE id=?").run(call.id);
  call.actionTicket = undefined;
}
async function finish(call: Call, status: string, reason: string) {
  if (call.finishing) return call.finishing;
  call.finishing = Promise.resolve().then(async () => {
    clearTimeout(call.timer); call.abort.abort();
    db.query("UPDATE calls SET status=?,ended_at=?,error=? WHERE id=?").run(status, Date.now(), reason, call.id);
    log(call.id, "ended", { status, reason });
    settleAction(call);
    call.rejectReady(new Error(reason));
    try { call.media?.send(JSON.stringify({ type: "close" })); call.media?.close(); } catch { log(call.id, "media-close-failed", {}); }
    await call.page?.close().catch(() => log(call.id, "page-close-failed", {}));
    if (call.voiceId) await voice(`/sessions/${encodeURIComponent(call.voiceId)}`, "PATCH", { ...voiceIdentity(call.id), seconds: call.usageSeconds, finalized: false });
    await cleanup(snapshot(call)); active.delete(call.id);
  });
  return call.finishing;
}
function create(brief: CallBrief, actionTicket?: ActionTicket): Call {
  let resolveReady!: () => void, rejectReady!: (e: Error) => void, resolveAudio!: () => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); void ready.catch(() => {});
  const call: Call = { id: randomUUID(), brief, actionTicket, token: randomBytes(32).toString("base64url"), dialState: "none", ready, resolveReady, rejectReady,
    audio: new Promise<void>(resolve => { resolveAudio = resolve; }), resolveAudio, outputBytes: 0, usageSeconds: 0, offerPending: false, transportGranted: false, transportNotified: false,
    abort: new AbortController(), transcript: [], seen: new Set(), delegations: new Set(), queue: Promise.resolve(), timer: setTimeout(() => void finish(call, "completed", "Maximum duration reached"), brief.maxSeconds * 1000) };
  db.query("INSERT INTO calls(id,status,brief,started_at,provider_kind,dial_state,request_id,action_id,action_ticket) VALUES(?,?,?,?,?,?,?,?,?)").run(call.id, "preparing", JSON.stringify(brief), Date.now(), "retell-takeover", "none", brief.requestId, actionTicket?.id ?? null, actionTicket ? JSON.stringify(actionTicket) : null);
  active.set(call.id, call); return call;
}
async function start(call: Call, shouldDial: boolean) {
  try {
    if (shouldDial) {
      const approved = await dispatch(call.id, "approved", { brief: call.brief });
      if (!approved.ok) { await finish(call, "failed", "Managed call approval unavailable; no dial dispatched"); return; }
      if (call.finishing) { await dispatch(call.id, "close", {}); return; }
    }
    if (!browser) {
      launching ??= chromium.launch({ executablePath: config.chromium, headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage"] }).then(b => { browser = b; b.on("disconnected", () => { browser = undefined; for (const c of active.values()) void finish(c, "failed", "Media browser disconnected"); }); return b; }).finally(() => { launching = undefined; });
      await launching;
    }
    if (call.finishing) return;
    const page = await browser!.newPage();
    if (call.finishing) { await page.close(); return; }
    call.page = page;
    await page.goto(`http://127.0.0.1:${localPort}/media#${call.token}`);
    const controller = setTimeout(() => call.rejectReady(new Error("Voice startup timed out")), 30_000);
    try { await call.ready; } finally { clearTimeout(controller); }
    if (!shouldDial || call.finishing) return;
    if (!call.actionTicket) { await finish(call, "failed", "Durable action dispatch ticket missing; no dial"); return; }
    const ticket = actionJournal.begin({ action: "telephone.dial", actedFor: owner, recipients: [call.brief.to], summary: call.brief.purpose, externalId: call.id });
    const result = await provider.client.dial(call.brief, call.id, call.abort.signal, () => {
      if (call.finishing || !call.actionTicket) return { ok: false, error: "Phone action no longer owns dispatch" };
      const contact = contactGuard(db, call.brief, config, Date.now(), undefined, call.id);
      if (!contact.ok) return contact;
      const permitted = actions.dispatch(call.actionTicket);
      if (!permitted.ok) return { ok: false, error: permitted.message };
      call.dialState = "dispatching";
      db.query("UPDATE calls SET status='dialing',dial_state='dispatching',cleanup=0 WHERE id=?").run(call.id);
      return { ok: true };
    });
    const warning = journalWarning(actionJournal.finish(ticket, result.ok ? "confirmed" : "unconfirmed", result.ok ? "PSTN dial accepted; not proof of delivery" : result.error));
    if (warning) log(call.id, "journal-outcome-pending", { error: warning });
    if (!result.ok) {
      call.dialState = result.uncertain ? "uncertain" : "rejected";
      db.query("UPDATE calls SET dial_state=? WHERE id=?").run(call.dialState, call.id);
      await finish(call, "failed", result.error); return;
    }
    call.providerId = result.value.uuid; call.dialState = "accepted";
    db.query("UPDATE calls SET provider_id=?,dial_state='accepted',accepted_at=?,cleanup=0 WHERE id=?").run(call.providerId, Date.now(), call.id);
    settleAction(call);
    if (call.finishing) { await cleanup(snapshot(call)); return; }
    // The monitor grant is available only after PSTN answers; the provider poll signals it.
  } catch { await finish(call, "failed", "Voice/PSTN startup failed"); }
}
async function delegate(call: Call, id: string) {
  const body = { brief: call.brief, delegationId: id, transcript: [...call.transcript] };
  log(call.id, "delegation-dispatch", { id });
  const accepted = await dispatch(call.id, "delegate", body);
  if (!accepted.ok) { send(call, { type: "session.commentary.append", event_id: randomUUID(), delegation_id: id, content: "The authorized reasoning service is unavailable. I cannot confirm that result." }); return; }
  const workId = accepted.value.workId;
  log(call.id, "delegation-accepted", { id, workId });
  while (!call.finishing) {
    const result = await dispatch(call.id, "result", { workId });
    if (!result.ok) { send(call, { type: "session.commentary.append", event_id: randomUUID(), delegation_id: id, content: "The reasoning result is unavailable. No additional action is confirmed." }); return; }
    if (result.value.state === "pending") continue;
    if (result.value.state !== "completed" || typeof result.value.text !== "string") { await finish(call, "failed", "Invalid managed dispatcher result"); return; }
    log(call.id, "delegation-result", { id, workId, text: result.value.text });
    for (const part of result.value.text.match(/[\s\S]{1,500}/g) ?? []) send(call, { type: "session.commentary.append", event_id: randomUUID(), delegation_id: id, content: part });
    return;
  }
}
const websocket = {
  maxPayloadLength: 256 * 1024, idleTimeout: 60,
  open(ws: Socket) { if (ws.data.side === "silent") for (const event of silentBegin()) ws.send(JSON.stringify(event)); },
  message(ws: Socket, value: string | Buffer) {
    if (typeof value !== "string") { ws.close(1008); return; }
    let m: any; try { m = JSON.parse(value); } catch { ws.close(1008); return; }
    if (ws.data.side === "silent") {
      const replies = silentReply(m); if (!replies.ok) { ws.close(1008); return; }
      if (replies.value) ws.send(JSON.stringify(replies.value)); return;
    }
    if (!ws.data.call) {
      const call = [...active.values()].find(c => sameToken(m.token, c.token));
      if (m.type !== "authenticate" || !call || call.media || call.finishing) { ws.close(1008); return; }
      ws.data.call = call; call.media = ws; return;
    }
    const call = ws.data.call;
    if (call.finishing) return;
    if (m.type === "ready") { call.resolveReady(); return; }
    if (m.type === "transport-ready") {
      if (!call.participantId || !call.transportGranted) { void finish(call, "failed", "Unconfirmed telephone takeover"); return; }
      db.query("UPDATE calls SET status='connected' WHERE id=?").run(call.id);
      send(call, { type: "session.instructions.append", event_id: randomUUID(), delegation_id: null, content: "The telephone connection is now live. Deliver the approved opening and listen." }); return;
    }
    if (m.type === "audio-proof" && Number.isSafeInteger(m.bytes) && m.bytes > 0) { call.outputBytes += m.bytes; call.resolveAudio(); return; }
    if (m.type === "error") { log(call.id, "media-error", { error: typeof m.error === "string" ? m.error.slice(0, 1000) : null }); void finish(call, "failed", "Media transport failed"); return; }
    if (m.type !== "live-event" || typeof m.event?.type !== "string") { void finish(call, "failed", "Unknown media control"); return; }
    const e = m.event;
    if (typeof e.event_id === "string") { if (call.seen.has(e.event_id)) return; call.seen.add(e.event_id); }
    if (["session.input_transcript.delta", "session.output_transcript.delta"].includes(e.type) && typeof e.delta === "string" && e.delta.length <= 4000) {
      call.transcript.push({ role: e.type === "session.input_transcript.delta" ? "callee" : "kenan", text: e.delta });
      log(call.id, e.type, e);
      if (call.transcript.length > 2000 || Buffer.byteLength(JSON.stringify(call.transcript)) > 128_000) void finish(call, "completed", "Conversation length bound reached");
    } else if (e.type === "session.delegation.created") {
      const id = e.delegation?.id;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id) || e.delegation.target !== "client" || call.delegations.has(id)) return;
      call.delegations.add(id); call.queue = call.queue.then(() => call.finishing ? undefined : delegate(call, id));
    } else if (["session.usage.updated", "session.closed"].includes(e.type)) {
      if (Number.isFinite(e.usage?.seconds)) call.usageSeconds = Math.max(call.usageSeconds, e.usage.seconds);
      if (e.type === "session.closed") void finish(call, "completed", "Voice session closed");
    } else if (e.type === "error") void finish(call, "failed", "Voice protocol error");
  },
  close(ws: Socket) { if (ws.data.side === "browser" && ws.data.call && !ws.data.call.finishing) void finish(ws.data.call, "completed", "Voice media disconnected"); },
};
// Import retained recent/uncertain effects before accepting new requests; this never dials.
for (const row of db.query("SELECT id,brief,dial_state,provider_id FROM calls WHERE action_id IS NULL AND (dial_state IN ('dispatching','uncertain') OR (dial_state='accepted' AND COALESCE(accepted_at,started_at)>?)) ORDER BY started_at DESC").all(Date.now() - 2 * 60 * 60 * 1000) as { id: string; brief: string; dial_state: Call["dialState"]; provider_id: string | null }[]) {
  const parsed = callBrief(JSON.parse(row.brief));
  if (!parsed.ok) throw new Error("Retained phone brief is invalid; action import requires repair");
  const submitted = actions.submit({ ...phoneIntent(parsed.value), requestId: `telephone-retained:${row.id}` });
  if (!submitted.ok) throw new Error("Retained telephone action import unavailable");
  if (submitted.value.disposition === "recipient-held") { log(row.id, "retained-action-recipient-fenced", { actionId: submitted.value.action.id }); continue; }
  db.query("UPDATE calls SET action_id=? WHERE id=?").run(submitted.value.action.id, row.id);
  if (submitted.value.action.state === "accepted") {
    const claimed = actions.claim(submitted.value.action.id, "phone-service-retained-import");
    if (!claimed.ok) throw new Error("Retained telephone effect could not acquire reconciliation custody");
    db.query("UPDATE calls SET action_ticket=? WHERE id=?").run(JSON.stringify(claimed.value), row.id);
    const settled = settlePhoneAction(actions, claimed.value, row.id, row.dial_state, row.provider_id);
    if (!settled.ok) throw new Error("Retained telephone effect could not be recorded");
    db.query("UPDATE calls SET action_ticket=NULL WHERE id=?").run(row.id);
  }
}
for (const row of db.query("SELECT id,action_ticket,dial_state,provider_id FROM calls WHERE action_ticket IS NOT NULL").all() as { id: string; action_ticket: string; dial_state: Call["dialState"]; provider_id: string | null }[]) {
  const result = settlePhoneAction(actions, JSON.parse(row.action_ticket), row.id, row.dial_state, row.provider_id);
  if (result.ok) db.query("UPDATE calls SET action_ticket=NULL WHERE id=?").run(row.id);
  else log(row.id, "action-recovery-pending", { error: result.error });
}
db.query("UPDATE calls SET status='interrupted',ended_at=?,error='Service restarted; never redial' WHERE ended_at IS NULL").run(Date.now());
for (const row of db.query("SELECT * FROM calls WHERE cleanup=0 AND ended_at IS NOT NULL").all() as Row[]) await cleanup(row);
const local = Bun.serve<SocketData>({ hostname: "127.0.0.1", port: localPort, maxRequestBodySize: 256 * 1024, websocket, async fetch(req, server) {
  const url = new URL(req.url), bearer = req.headers.get("authorization");
  if (url.pathname === "/media" && req.method === "GET") return new Response(html, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
  if (url.pathname === "/media/retell-sdk.js" && req.method === "GET") return new Response(Bun.file(new URL("./dist/retell-sdk.js", import.meta.url)), { headers: { "content-type": "text/javascript" } });
  if (url.pathname === "/browser-media" && server.upgrade(req, { data: { side: "browser" } })) return;
  if (url.pathname.startsWith("/media/")) {
    const call = [...active.values()].find(c => sameToken(bearer, `Bearer ${c.token}`));
    if (!call || call.finishing) return error("Owned media capability required", 403);
    if (req.method !== "POST") return error("POST required", 405);
    let body: any; try { body = await req.json(); } catch { return error("JSON required"); }
    if (url.pathname === "/media/offer") {
      if (call.voiceId || call.offerPending) return error("Voice offer already accepted", 409);
      if (typeof body?.sdp !== "string") return error("SDP required");
      call.offerPending = true;
      const result = await voice("/sessions", "POST", { ...voiceIdentity(call.id), sdp: body.sdp, instructions: instructions(call.brief) });
      call.offerPending = false;
      if (!result.ok) return error(result.error, 502);
      call.voiceId = result.value.session.id;
      db.query("UPDATE calls SET voice_id=?,cleanup=0 WHERE id=?").run(call.voiceId!, call.id);
      if (call.finishing) { await cleanup(snapshot(call)); return error("Call ended", 410); }
      return json(result.value);
    }
    if (!call.providerId) return error("Telephone dial not accepted yet", 409);
    if (url.pathname === "/media/transport") {
      if (call.participantId) return error("Monitor grant already issued", 409);
      const result = await provider.client.listen(call.providerId);
      if (!result.ok) return error(result.error, 409);
      call.participantId = result.value.participant_id;
      if (call.finishing) return error("Call ended", 410);
      return json({ callId: call.providerId, accessToken: result.value.access_token, participantId: call.participantId, transport: result.value.transport, url: result.value.url, iceServers: result.value.ice_servers });
    }
    if (url.pathname === "/media/takeover") {
      if (!call.participantId || body.participantId !== call.participantId || body.callId !== call.providerId || Object.keys(body).length !== 2) return error("Owned monitor participant required", 403);
      if (call.transportGranted) return json({ takenOver: true });
      const result = await provider.client.takeOver(call.providerId, call.participantId);
      if (!result.ok) return error(result.error, 502);
      call.transportGranted = true; log(call.id, "transport-takeover", { providerId: call.providerId });
      return json({ takenOver: true });
    }
    return error("Unknown media operation", 404);
  }
  if (!sameToken(bearer, `Bearer ${adminToken}`)) return error("Owner authorization required", 403);
  if (url.pathname === "/status") return json({ enabled: true, callingEnabled: config.callingEnabled === true, releaseCommit, pstnProvider: provider.kind, storedCallerId: provider.callerId, model: "gpt-live-1", intelligence: "managed-kenan", activeCalls: active.size });
  if (url.pathname === "/calls" && req.method === "GET") return json(db.query("SELECT id,request_id,provider_id,provider_kind,dial_state,status,started_at,ended_at,error FROM calls ORDER BY started_at DESC LIMIT 50").all());
  if (url.pathname === "/calls" && req.method === "POST") {
    let body: unknown; try { body = await req.json(); } catch { return error("JSON required"); }
    const brief = callBrief(body); if (!brief.ok) return error(brief.error);
    const previous = db.query("SELECT id,brief,status FROM calls WHERE request_id=?").get(brief.value.requestId) as { id: string; brief: string; status: string } | null;
    if (previous) return previous.brief === JSON.stringify(brief.value) ? json({ id: previous.id, status: previous.status, replayed: false }) : error("Approved request identity already belongs to another brief", 409);
    if (selected.value === null || config.callingEnabled !== true) return error("Calling disabled until provider/number and silent takeover agent are confirmed", 409);
    if (stopping || active.size >= 2) return error("Phone service busy", 409);
    const permitted = contactGuard(db, brief.value, config, Date.now());
    if (!permitted.ok) return json(permitted, permitted.code === "contact-policy-unavailable" ? 503 : 409);
    let approval: { actionId: string; callId: string; reconciledAt: number; reason: string } | undefined;
    if (permitted.approval) {
      const prior = db.query("SELECT action_id FROM calls WHERE id=?").get(permitted.approval.callId) as { action_id: string | null } | null;
      if (!prior?.action_id) return error("Prior call lacks durable action reconciliation; no follow-up permitted", 409);
      approval = { ...permitted.approval, actionId: prior.action_id };
    }
    const reserved = reservePhoneAction(actions, brief.value, approval);
    if (!reserved.ok) return json({ code: reserved.error, error: reserved.message, ...("action" in reserved && reserved.action ? { action: { id: reserved.action.id, state: reserved.action.state, result: reserved.action.result } } : {}) }, reserved.error === "unavailable" ? 503 : 409);
    const call = create(brief.value, reserved.value); void start(call, true); return json({ id: call.id, status: "preparing" }, 202);
  }
  if (url.pathname === "/preflight" && req.method === "POST") {
    if (stopping || active.size) return error("Phone service busy", 409);
    const call = create({ requestId: randomUUID(), to: "+15555550100", purpose: "Audio-only preflight; no telephone dial.", shareableFacts: [], opening: "This is an audio connection test.", maxSeconds: 60 });
    void start(call, false);
    try {
      await call.ready; call.media?.send(JSON.stringify({ type: "preflight", text: "Audio-only preflight: speak the approved opening." }));
      let timer!: ReturnType<typeof setTimeout>;
      try { await Promise.race([call.audio, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("No audio")), 10_000); })]); } finally { clearTimeout(timer); }
      await finish(call, "preflight", "No telephone call placed"); return json({ ready: true, model: "gpt-live-1", audioOutputBytes: call.outputBytes, placedCall: false });
    } catch { await finish(call, "failed", "Preflight failed"); return error("Voice audio preflight failed", 502); }
  }
  const match = /^\/calls\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (match && req.method === "DELETE") { const call = active.get(match[1]!); if (!call) return error("Active call not found", 404); await finish(call, "completed", "Ended by owner"); return json({ ended: true }); }
  if (match && req.method === "GET") { const call = db.query("SELECT * FROM calls WHERE id=?").get(match[1]!); return call ? json({ call, events: db.query("SELECT at,type,payload FROM events WHERE call_id=? ORDER BY id").all(match[1]!) }) : error("Call not found", 404); }
  return error("Unknown phone operation", 404);
} });
const publicListener = Bun.serve<SocketData>({ hostname: "127.0.0.1", port: publicPort, websocket, fetch(req, server) {
  const route = /^\/retell\/silent\/([^/]+)\/(call_[A-Za-z0-9]+)$/.exec(new URL(req.url).pathname);
  if (!route || !sameToken(route[1]!, silentToken)) return error("Unknown public phone operation", 404);
  if (server.upgrade(req, { data: { side: "silent", providerId: route[2]! } })) return;
  return error("WebSocket required", 400);
} });
const syncing = new Set<string>();
const poll = setInterval(() => { for (const call of active.values()) {
  if (!call.providerId || call.finishing || syncing.has(call.id)) continue;
  syncing.add(call.id);
  void provider.client.get(call.providerId).then(result => {
    if (!result.ok) { void finish(call, "failed", "Provider state unavailable"); return; }
    db.query("UPDATE calls SET provider_snapshot=? WHERE id=?").run(JSON.stringify(result.value), call.id);
    if (result.value.call_status === "ongoing" && !call.transportNotified && !call.finishing) {
      call.transportNotified = true;
      call.media?.send(JSON.stringify({ type: "transport", callId: call.providerId }));
    }
    if (["ended", "error", "not_connected"].includes(result.value.call_status) && result.value.disconnection_reason !== "call_take_over") void finish(call, result.value.call_status === "ended" ? "completed" : "failed", "Telephone disconnected");
  }).finally(() => syncing.delete(call.id));
} }, 1000);
const heartbeat = setInterval(() => { for (const call of active.values()) if (call.voiceId && !call.finishing) void voice(`/sessions/${encodeURIComponent(call.voiceId)}`, "PATCH", { ...voiceIdentity(call.id), seconds: call.usageSeconds, finalized: false }).then(r => { if (!r.ok) void finish(call, "failed", "Voice lifecycle expired"); }); }, 20_000);
const recover = setInterval(() => { for (const row of db.query("SELECT * FROM calls WHERE cleanup=0 AND ended_at IS NOT NULL").all() as Row[]) if (!active.has(row.id)) void cleanup(row); }, 60_000);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { if (stopping) return; stopping = true; clearInterval(poll); clearInterval(heartbeat); clearInterval(recover); void Promise.all([...active.values()].map(c => finish(c, "interrupted", "Phone service stopping"))).then(async () => { await browser?.close(); local.stop(); publicListener.stop(); process.exit(0); }); });
console.log(`Pi Stack Phone ready on loopback ${localPort}/${publicPort}`);
