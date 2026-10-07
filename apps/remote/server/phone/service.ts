import { Database } from "bun:sqlite";
import { actionJournal, journalWarning } from "kenan-memory/journal";
import { chromium, type Browser, type Page } from "playwright-core";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { callBrief, instructions, type CallBrief } from "./policy";
import { Vonage, signedWebhook } from "./vonage";
import { SimGateways } from "./gateway";

const config = JSON.parse(readFileSync(process.env.PI_STACK_PHONE_CONFIG ?? "/etc/pi-stack/phone.json", "utf8"));
const state = process.env.PI_STACK_PHONE_STATE;
if (!state) throw new Error("PI_STACK_PHONE_STATE must select the person's encrypted phone state");
mkdirSync(state, { recursive: true, mode: 0o700 });
const adminToken = readFileSync(config.adminTokenFile, "utf8").trim();
const provider = config.vonageCredentialFile ? new Vonage(config.vonageCredentialFile) : null;
const publicBase = String(config.publicBaseUrl).replace(/\/$/, "");
if (provider && !publicBase.startsWith("https://")) throw new Error("Vonage requires a public HTTPS/WSS callback endpoint");
const localPort = Number(config.localPort ?? 8802);
const publicPort = Number(config.publicPort ?? 8803);
const voiceBase = config.voiceUrl ?? "http://127.0.0.1:8796";
const owner = config.owner ?? "kenan";
const db = new Database(join(state, "calls.sqlite3"));
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,provider_id TEXT,voice_id TEXT,status TEXT NOT NULL,brief TEXT NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER,error TEXT,cleanup INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,call_id TEXT NOT NULL,at INTEGER NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL);`);
if (!(db.query("PRAGMA table_info(calls)").all() as { name: string }[]).some(c => c.name === "gateway_id")) db.exec("ALTER TABLE calls ADD COLUMN gateway_id TEXT");
const json = (v: unknown, status = 200) => Response.json(v, { status });
const error = (message: string, status = 400) => json({ error: message }, status);
const releaseFile = new URL("../../.pi-stack-commit", import.meta.url);
const releaseCommit = existsSync(releaseFile) ? readFileSync(releaseFile, "utf8").trim() : null;
const html = readFileSync(new URL("./media.html", import.meta.url), "utf8");
const active = new Map<string, Call>();
let browser: Browser | undefined;
let launching: Promise<Browser> | undefined;
let stopping = false;
type SocketData = { call?: Call; gatewayId?: string; side: "browser" | "provider" | "gateway" };
type Socket = import("bun").ServerWebSocket<SocketData>;
type Call = { id: string; gatewayId?: string; telephoneConnected?: boolean; brief: CallBrief; token: string; providerToken: string; page?: Page; media?: Socket; provider?: Socket; voiceId?: string; providerId?: string; offerPending?: boolean; timer: ReturnType<typeof setTimeout>; ready: Promise<void>; resolveReady: () => void; rejectReady: (e: Error) => void; audio: Promise<void>; resolveAudio: () => void; audioOutputBytes: number; usageSeconds: number; finishing?: Promise<void> };
const gateways = new SimGateways((config.simGateways ?? []).map((g: { id: string; name: string; tokenFile: string }) => ({ id: g.id, name: g.name, token: deviceToken(g.tokenFile) })), {
  state(id, state, reason) {
    const c = active.get(id); if (!c || c.finishing) return;
    log(id, "sim-status", { state, reason });
    if (state === "active") {
      db.query("UPDATE calls SET status='connected' WHERE id=?").run(id);
      if (!c.telephoneConnected) {
        c.telephoneConnected = true;
        try { if (c.media?.send(JSON.stringify({ type: "context", text: "The telephone connection is now live. Deliver the approved opening and listen." })) === 0) void finish(c, "failed", "SIM opening dispatch dropped"); }
        catch { void finish(c, "failed", "SIM opening dispatch failed"); }
      }
    } else if (state === "ended" || state === "failed") void finish(c, state === "ended" ? "completed" : "failed", reason);
    else if (state === "dialing" || state === "ringing") db.query("UPDATE calls SET status=? WHERE id=?").run(state, id);
    else { state satisfies never; void finish(c, "failed", "Unsupported SIM call state"); }
  },
  audio(id, data) {
    const c = active.get(id); if (!c?.media || c.finishing || !c.telephoneConnected) return;
    if (c.media.getBufferedAmount() > 6400) { void finish(c, "failed", "SIM audio backpressure"); return; }
    try { if (c.media.send(data) === 0) void finish(c, "failed", "SIM audio dispatch dropped"); }
    catch { void finish(c, "failed", "SIM audio dispatch failed"); }
  },
});
function deviceToken(file: string): string {
  const token = readFileSync(file, "utf8").trim();
  if (same(token, adminToken)) throw new Error("SIM device tokens must be separate from owner authorization");
  return token;
}
function same(a: string | null, b: string) { const x = Buffer.from(a ?? ""), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function log(id: string, type: string, payload: unknown) { db.query("INSERT INTO events(call_id,at,type,payload) VALUES(?,?,?,?)").run(id, Date.now(), type, JSON.stringify(payload)); }
function ncco(call: Call) { return [{ action: "connect", endpoint: [{ type: "websocket", uri: `${publicBase.replace(/^https:/, "wss:")}/vonage/media`, "content-type": "audio/l16;rate=16000", authorization: { type: "custom", value: `Bearer ${call.providerToken}` }, headers: { callId: call.id } }] }]; }
async function voice(path: string, method: string, body: unknown) {
  try { const response = await fetch(`${voiceBase}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(35_000) }); const value = await response.json(); return response.ok ? { ok: true as const, value } : { ok: false as const, error: String(value.error ?? "Voice request failed") }; }
  catch { return { ok: false as const, error: "Voice service unavailable" }; }
}
async function cleanup(row: { id: string; provider_id: string | null; voice_id: string | null }) {
  const results = await Promise.all([row.provider_id && provider ? provider.hangup(row.provider_id) : { ok: true }, row.voice_id ? voice(`/sessions/${encodeURIComponent(row.voice_id)}`, "DELETE", { owner, threadId: `phone:${row.id}` }) : { ok: true }]);
  const failures = results.filter(r => !r.ok).map(r => "error" in r ? r.error : "cleanup failed");
  if (!failures.length) db.query("UPDATE calls SET cleanup=1 WHERE id=?").run(row.id);
  else { db.query("UPDATE calls SET error=?,cleanup=0 WHERE id=?").run(failures.join("; "), row.id); console.error(`Phone call ${row.id}: cleanup pending`); }
}
async function finish(call: Call, status: string, reason?: string) {
  if (call.finishing) return call.finishing;
  call.finishing = Promise.resolve().then(async () => {
    clearTimeout(call.timer);
    if (call.gatewayId) gateways.end(call.gatewayId, call.id);
    db.query("UPDATE calls SET status=?,ended_at=?,error=? WHERE id=?").run(status, Date.now(), reason ?? null, call.id);
    call.rejectReady(new Error(reason ?? "Call ended"));
    try { call.media?.send(JSON.stringify({ type: "close" })); } catch { log(call.id, "cleanup-notice", { error: "Media close notification failed" }); }
    for (const socket of [call.media, call.provider]) try { socket?.close(); } catch { log(call.id, "cleanup-notice", { error: "Audio socket was already closed" }); }
    await call.page?.close().catch(() => {});
    if (call.voiceId) { const usage = await voice(`/sessions/${encodeURIComponent(call.voiceId)}`, "PATCH", { owner, threadId: `phone:${call.id}`, seconds: call.usageSeconds, finalized: false }); if (!usage.ok) log(call.id, "usage-error", { error: usage.error }); }
    await cleanup({ id: call.id, provider_id: call.providerId ?? null, voice_id: call.voiceId ?? null });
    active.delete(call.id);
  });
  return call.finishing;
}
function create(brief: CallBrief, providerId?: string, id = randomUUID(), gatewayId?: string): Call {
  let resolveReady!: () => void, rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  let resolveAudio!: () => void;
  const audio = new Promise<void>(resolve => { resolveAudio = resolve; });
  const call: Call = { id, gatewayId, brief, audio, resolveAudio, audioOutputBytes: 0, usageSeconds: 0, token: randomBytes(32).toString("base64url"), providerToken: randomBytes(32).toString("base64url"), providerId, ready, resolveReady, rejectReady, timer: setTimeout(() => void finish(call, "completed", "Maximum call duration reached"), (brief.maxSeconds ?? 300) * 1000) };
  db.query("INSERT INTO calls(id,provider_id,status,brief,started_at,gateway_id) VALUES(?,?,?,?,?,?)").run(id, providerId ?? null, "preparing", JSON.stringify(brief), Date.now(), gatewayId ?? null); active.set(id, call);
  return call;
}
async function start(call: Call, dial = true) {
  try {
    if (!browser) {
      launching ??= chromium.launch({ executablePath: config.chromium ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage"] }).then(b => { browser = b; b.on("disconnected", () => { browser = undefined; for (const c of active.values()) void finish(c, "failed", "Audio transport disconnected"); }); return b; }).finally(() => { launching = undefined; });
      await launching;
    }
    if (call.finishing) return;
    const page = await browser!.newPage();
    if (call.finishing) { await page.close(); return; }
    call.page = page;
    await call.page.goto(`http://127.0.0.1:${localPort}/media#${call.token}`);
    await Promise.race([call.ready, new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error("Voice startup timed out")), 35_000); t.unref(); })]);
    if (call.finishing) return;
    if (dial && !call.providerId) {
      db.query("UPDATE calls SET status='dialing' WHERE id=?").run(call.id);
      if (!call.gatewayId && !provider) { await finish(call, "failed", "Vonage is not configured"); return; }
      const ticket = actionJournal.begin({ action: "telephone.dial", actedFor: owner, recipients: [call.brief.to], summary: call.brief.purpose, externalId: call.id });
      const record = (ok: boolean, detail: string) => {
        const warning = journalWarning(actionJournal.finish(ticket, ok ? "confirmed" : "unconfirmed", detail));
        if (warning) { log(call.id, "journal-outcome-pending", { error: warning }); db.query("UPDATE calls SET error=? WHERE id=?").run(warning, call.id); }
      };
      if (call.gatewayId) {
        const result = gateways.dial(call.gatewayId, call.id, call.brief.to, call.brief.maxSeconds ?? 300);
        record(result.ok, result.ok ? "SIM dial command accepted; not proof of a connected call" : result.error);
        if (!result.ok) await finish(call, "failed", result.error);
        return;
      }
      const result = await provider!.dial(call.brief.to, ncco(call), `${publicBase}/vonage/events/${call.id}`);
      record(result.ok, result.ok ? `Provider accepted call ${result.value.uuid}; not proof of a connected call` : result.error);
      if (!result.ok) { await finish(call, "failed", result.error); return; }
      call.providerId = result.value.uuid;
      db.query("UPDATE calls SET provider_id=?,cleanup=0 WHERE id=?").run(call.providerId, call.id);
      if (call.finishing) await cleanup({ id: call.id, provider_id: call.providerId, voice_id: call.voiceId ?? null });
    }
  } catch (e) { await finish(call, "failed", e instanceof Error ? e.message.slice(0, 300) : "Audio startup failed"); }
}
const socketOptions = {
  maxPayloadLength: 256 * 1024,
  idleTimeout: 60,
  open(ws: Socket) { if (ws.data.side === "gateway") { gateways.connected(ws.data.gatewayId!, ws); return; } if (ws.data.side === "provider") { const c = ws.data.call!; c.provider = ws; db.query("UPDATE calls SET status='connected' WHERE id=?").run(c.id); c.media?.send(JSON.stringify({ type: "context", text: "The telephone connection is now live. Deliver the approved opening and listen." })); return; } if (ws.data.side === "browser") return; ws.data.side satisfies never; ws.close(1008); },
  message(ws: Socket, message: string | Buffer) {
    if (ws.data.side === "gateway") { gateways.receive(ws.data.gatewayId!, ws, message); return; }
    if (ws.data.side !== "browser" && ws.data.side !== "provider") { ws.data.side satisfies never; ws.close(1008); return; }
    if (ws.data.side === "browser" && !ws.data.call) {
      if (typeof message !== "string") { ws.close(1008); return; }
      try { const m = JSON.parse(message); const c = [...active.values()].find(c => same(m.token, c.token)); if (m.type !== "authenticate" || !c || c.media || c.finishing) { ws.close(1008); return; } ws.data.call = c; c.media = ws; return; } catch { ws.close(1008); return; }
    }
    const c = ws.data.call; if (!c || c.finishing) return;
    if (typeof message !== "string") { if (ws.data.side === "browser") { c.audioOutputBytes += message.length; let speechSamples = 0; for (let i = 0; i + 1 < message.length; i += 2) if (Math.abs(message.readInt16LE(i)) > 300) speechSamples++; if (speechSamples > 20) c.resolveAudio(); } if (message.length > 6400 || message.length % 2) { void finish(c, "failed", "Invalid telephone audio packet"); return; } if (ws.data.side === "browser" && c.gatewayId) { gateways.audio(c.gatewayId, c.id, message); return; } const target = ws.data.side === "provider" ? c.media : c.provider; if (target) {
      try {
        if (target.getBufferedAmount() >= 64_000 || target.send(message) === 0) void finish(c, "failed", "Audio transport backpressure");
      } catch { void finish(c, "failed", "Audio transport dispatch failed"); }
    } return; }
    try {
      const m = JSON.parse(message);
      if (ws.data.side === "provider") {
        if (m.event === "websocket:connected") log(c.id, "connected", {});
        else log(c.id, "unsupported-provider-event", { event: String(m.event).slice(0, 200) });
        return;
      }
      if (m.type === "ready") { c.resolveReady(); if (c.provider) c.media?.send(JSON.stringify({ type: "context", text: "The telephone connection is now live. Deliver the approved opening and listen." })); return; }
      if (m.type === "error") { void finish(c, "failed", String(m.error).slice(0, 300)); return; }
      if (m.type === "live-event") {
        const e = m.event;
        if (typeof e?.type !== "string") { void finish(c, "failed", "Invalid GPT Live event type"); return; }
        if (["session.input_transcript.delta", "session.output_transcript.delta", "session.output_audio.delta", "session.usage.updated", "session.delegation.created", "session.closed", "error"].includes(e.type) && e.type !== "session.output_audio.delta") log(c.id, e.type, e);
        if (["session.usage.updated", "session.closed"].includes(e.type) && Number.isFinite(e.usage?.seconds)) c.usageSeconds = Math.max(c.usageSeconds, e.usage.seconds);
        if (e.type === "session.delegation.created") c.media?.send(JSON.stringify({ type: "context", text: "No additional information or authority is available for this call. Use the approved brief, or tell the caller that you will ask Hara and note their question." }));
        if (e.type === "session.closed" || e.type === "error") void finish(c, e.type === "error" ? "failed" : "completed", e.type === "error" ? "GPT Live reported an error" : undefined);
        if (!["session.input_transcript.delta", "session.output_transcript.delta", "session.output_audio.delta", "session.usage.updated", "session.delegation.created", "session.closed", "error"].includes(e.type))
          log(c.id, "unsupported-live-event", { type: e.type.slice(0, 200) });
        return;
      }
      void finish(c, "failed", "Unsupported telephone media control type");
    } catch { void finish(c, "failed", "Malformed audio control message"); }
  },
  close(ws: Socket) { if (ws.data.side === "gateway") { gateways.disconnected(ws.data.gatewayId!, ws); return; } if (ws.data.side !== "browser" && ws.data.side !== "provider") { ws.data.side satisfies never; throw new Error("Unsupported telephone WebSocket side"); } const c = ws.data.call; if (c && !c.finishing) void finish(c, "completed", `${ws.data.side} disconnected`); },
};
const local = Bun.serve<SocketData>({ hostname: "127.0.0.1", port: localPort, maxRequestBodySize: 256 * 1024, websocket: socketOptions, async fetch(req, server) {
  const url = new URL(req.url);
  if (url.pathname === "/media" && req.method === "GET") return new Response(html, { headers: { "content-type": "text/html", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline' blob:; worker-src blob:; connect-src 'self' ws://127.0.0.1:*; media-src blob:" } });
  if (url.pathname === "/browser-media" && server.upgrade(req, { data: { side: "browser" } })) return;
  const bearer = req.headers.get("authorization");
  if (url.pathname === "/media/offer" && req.method === "POST") {
    const c = [...active.values()].find(c => same(bearer, `Bearer ${c.token}`)); if (!c || c.finishing) return error("Unknown media session", 403);
    if (c.voiceId || c.offerPending) return error("Voice offer already accepted", 409);
    let body; try { body = await req.json(); } catch { return error("JSON required"); }
    if (!body || typeof body.sdp !== "string") return error("SDP required");
    if (c.voiceId || c.offerPending || c.finishing) return error("Voice offer already accepted", 409);
    c.offerPending = true;
    const result = await voice("/sessions", "POST", { owner, threadId: `phone:${c.id}`, sdp: body.sdp, instructions: instructions(c.brief) });
    c.offerPending = false;
    if (!result.ok) return error(result.error, 502);
    c.voiceId = result.value.session.id; db.query("UPDATE calls SET voice_id=?,cleanup=0 WHERE id=?").run(c.voiceId!, c.id);
    if (c.finishing) { await cleanup({ id: c.id, provider_id: c.providerId ?? null, voice_id: c.voiceId ?? null }); return error("Call ended", 410); }
    return json(result.value);
  }
  if (!same(bearer, `Bearer ${adminToken}`)) return error("Owner authorization required", 403);
  if (url.pathname === "/status") return json({ enabled: true, callingEnabled: config.callingEnabled === true, releaseCommit, storedCallerId: provider?.credentials.VONAGE_FROM_NUMBER ?? null, model: "gpt-live-1", activeCalls: active.size, simGateways: gateways.snapshots() });
  if (url.pathname === "/preflight" && req.method === "POST") {
    if (stopping || active.size) return error("Phone service is busy", 409);
    const c = create({ to: "+15555550100", purpose: "Check the telephone audio connection without calling anyone.", shareableFacts: [], opening: "This is an audio connection test.", maxSeconds: 60 });
    void start(c, false);
    try {
      await c.ready;
      c.media?.send(JSON.stringify({ type: "context", text: "Audio test: speak the approved opening now." }));
      await Promise.race([c.audio, new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error("No Voice audio received")), 10_000); t.unref(); })]);
      await finish(c, "preflight", "No telephone call placed");
      return json({ ready: true, model: "gpt-live-1", audioOutputBytes: c.audioOutputBytes, placedCall: false });
    }
    catch (cause) {
      const diagnostics = await c.page?.evaluate(() => (window as any).telephoneMediaDiagnostics?.()).catch(() => null);
      log(c.id, "preflight-error", { error: cause instanceof Error ? cause.message : "Preflight failed", diagnostics });
      await finish(c, "failed", "Preflight failed"); return error("Voice audio preflight failed", 502);
    }
  }
  if (url.pathname === "/gateways" && req.method === "GET") return json({ gateways: gateways.snapshots() });
  if (url.pathname === "/sim-calls" && req.method === "POST") {
    if (stopping || active.size >= 2) return error("Phone service is busy", 409);
    let body; try { body = await req.json(); } catch { return error("JSON required"); }
    if (!body || typeof body !== "object" || typeof body.gatewayId !== "string" || Object.keys(body).some(k => !["gatewayId", "brief"].includes(k))) return error("A gateway ID and approved brief are required");
    const result = callBrief(body.brief); if (!result.ok) return error(result.error);
    if (stopping || active.size >= 2) return error("Phone service is busy", 409);
    const id = randomUUID(), reserved = gateways.reserve(body.gatewayId, id);
    if (!reserved.ok) return error(reserved.error, 409);
    let c: Call;
    try { c = create(result.value, undefined, id, body.gatewayId); }
    catch (cause) { gateways.end(body.gatewayId, id); throw cause; }
    void start(c); return json({ id, status: "preparing", transport: "sim", gatewayId: body.gatewayId }, 202);
  }
  if (url.pathname === "/calls" && req.method === "GET") return json(db.query("SELECT id,provider_id,gateway_id,status,started_at,ended_at,error FROM calls ORDER BY started_at DESC LIMIT 50").all());
  if (url.pathname === "/calls" && req.method === "POST") {
    if (!provider || config.callingEnabled !== true) return error("Confirm provider credit and number ownership, then enable calling in host configuration", 409);
    if (stopping || active.size >= 2) return error("Phone service is busy", 409);
    let body; try { body = await req.json(); } catch { return error("JSON required"); }
    const result = callBrief(body); if (!result.ok) return error(result.error);
    if (stopping || active.size >= 2) return error("Phone service is busy", 409);
    const c = create(result.value); void start(c); return json({ id: c.id, status: "preparing" }, 202);
  }
  const match = /^\/calls\/([^/]+)(\/context)?$/.exec(url.pathname);
  if (match) {
    const c = active.get(match[1]!);
    if (req.method === "DELETE") { if (!c) return error("Active call not found", 404); await finish(c, "completed", "Ended by owner"); return json({ ended: true, telephoneHangupPending: Boolean(c.gatewayId && gateways.snapshots().some(g => g.callId === c.id)) }); }
    if (req.method === "POST" && match[2]) { if (!c?.media) return error("Active call not found", 404); let b; try { b = await req.json(); } catch { return error("JSON required"); } if (!b || typeof b !== "object" || Object.keys(b).length !== 1 || typeof b.shareableFact !== "string" || b.shareableFact.length > 2000) return error("One bounded explicitly shareable fact is required"); log(c.id, "approved-context", { shareableFact: b.shareableFact }); c.media.send(JSON.stringify({ type: "context", text: `Hara approved this additional shareable fact: ${b.shareableFact}` })); return json({ accepted: true }); }
    if (req.method === "GET") { const row = db.query("SELECT * FROM calls WHERE id=?").get(match[1]!); return row ? json({ call: row, events: db.query("SELECT at,type,payload FROM events WHERE call_id=? ORDER BY id").all(match[1]!) }) : error("Call not found", 404); }
  }
  return error("Unknown phone operation", 404);
} });
Bun.serve<SocketData>({ hostname: "127.0.0.1", port: publicPort, maxRequestBodySize: 64 * 1024, websocket: socketOptions, async fetch(req, server) {
  const url = new URL(req.url);
  if (url.pathname === "/gateway/connect") {
    const gatewayId = gateways.authenticate(req.headers.get("authorization"));
    if (!gatewayId) return error("Gateway device authorization required", 403);
    if (server.upgrade(req, { data: { side: "gateway", gatewayId } })) return;
    return error("Gateway WebSocket required");
  }
  if (!provider) return error("Vonage is not configured", 404);
  if (url.pathname === "/vonage/media") { const c = [...active.values()].find(c => same(req.headers.get("authorization"), `Bearer ${c.providerToken}`)); if (!c || c.provider || c.finishing) return error("Unauthorized audio connection", 403); if (server.upgrade(req, { data: { side: "provider", call: c } })) return; return error("WebSocket required"); }
  if (req.method !== "POST") return error("POST webhook required", 405);
  const rawBody = await req.text();
  if (!signedWebhook(req.headers.get("authorization"), provider.credentials.VONAGE_SIGNATURE_SECRET, Date.now(), rawBody)) return error("Signed Vonage webhook required", 403);
  const eventMatch = /^\/vonage\/events\/([^/]+)$/.exec(url.pathname);
  let body: Record<string, any>; try { body = JSON.parse(rawBody); } catch { return error("JSON required"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return error("Webhook object required");
  if (eventMatch || url.pathname === "/vonage/events") {
    const stored = eventMatch ? null : db.query("SELECT id FROM calls WHERE provider_id=?").get(String(body.uuid ?? "")) as { id: string } | null;
    const id = eventMatch?.[1] ?? stored?.id;
    if (!id) return json({ accepted: true });
    const c = active.get(id);
    if (c?.providerId && body.uuid !== c.providerId) return error("Call identity mismatch", 403);
    log(id, "provider-status", { status: body.status, uuid: body.uuid });
    if (c && ["completed", "busy", "cancelled", "unanswered", "rejected", "failed", "timeout"].includes(body.status)) void finish(c, body.status === "completed" ? "completed" : "failed", body.status);
    return json({ accepted: true });
  }
  if (url.pathname === "/vonage/answer") {
    if (config.callingEnabled !== true || stopping || active.size >= 2 || !body.uuid || String(body.to).replace(/^\+/, "") !== provider.credentials.VONAGE_FROM_NUMBER.replace(/^\+/, "")) return json([{ action: "talk", text: "Kenan is unavailable. Please call again later." }]);
    const previous = db.query("SELECT id FROM calls WHERE provider_id=?").get(body.uuid) as { id: string } | null;
    if (previous) { const c = active.get(previous.id); return c ? json(ncco(c)) : json([]); }
    const c = create({ to: `+${String(body.from).replace(/^\+/, "")}`, purpose: "Receive a call for Hara's AI assistant Kenan and take a message.", shareableFacts: ["You are Kenan, Hara's AI assistant.", "You can take a message for Hara but cannot share her private information or confirm private details."], opening: "Hello, I'm Kenan, Hara's AI assistant. How can I help?", maxSeconds: 300 }, body.uuid);
    void start(c); return json(ncco(c));
  }
  return error("Unknown public phone operation", 404);
} });
const gatewayWatchdog = setInterval(() => gateways.expire(), 1000);
const heartbeat = setInterval(() => { for (const c of active.values()) if (c.voiceId && !c.finishing) void voice(`/sessions/${encodeURIComponent(c.voiceId)}`, "PATCH", { owner, threadId: `phone:${c.id}`, seconds: c.usageSeconds, finalized: false }).then(r => { if (!r.ok) void finish(c, "failed", r.error); }); }, 20_000);
const recover = setInterval(() => { for (const row of db.query("SELECT id,provider_id,voice_id FROM calls WHERE cleanup=0 AND ended_at IS NOT NULL").all() as any[]) if (!active.has(row.id)) void cleanup(row); }, 60_000);
db.query("UPDATE calls SET status='interrupted',ended_at=?,error='Service restarted; call not replayed' WHERE ended_at IS NULL").run(Date.now());
for (const row of db.query("SELECT id,provider_id,voice_id FROM calls WHERE cleanup=0 AND ended_at IS NOT NULL").all() as any[]) await cleanup(row);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { if (stopping) return; stopping = true; clearInterval(heartbeat); clearInterval(gatewayWatchdog); clearInterval(recover); void Promise.all([...active.values()].map(c => finish(c, "interrupted", "Phone service stopping"))).then(async () => { await browser?.close(); local.stop(); process.exit(0); }); });
console.log(`Pi Stack Phone ready on loopback ${localPort}/${publicPort}`);
