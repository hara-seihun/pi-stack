import { Database } from "bun:sqlite";
import { chromium, type Browser, type Page } from "playwright-core";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { callBrief, instructions, type CallBrief } from "./policy";
import { signedWebhook } from "./vonage";
import { providerSelection, loadProvider, mediaInstructions, dial, type PhoneProvider, type ProviderKind } from "./provider";
import { signedCompatibilityWebhook, signedTwilioUpgrade, compatibilityTerminal, compatibilityEnded, compatibilityUnavailable, type CompatibilityKind } from "./compatibility";
import { CompatibilityMediaSession } from "./compatibility-media";
const isCompatibility = (kind: ProviderKind | null): kind is CompatibilityKind => kind === "signalwire" || kind === "twilio";
import { SimGateways } from "./gateway";

const config = JSON.parse(readFileSync(process.env.PI_STACK_PHONE_CONFIG ?? "/etc/pi-stack/phone.json", "utf8"));
const state = process.env.PI_STACK_PHONE_STATE;
if (!state) throw new Error("PI_STACK_PHONE_STATE must select the person's encrypted phone state");
mkdirSync(state, { recursive: true, mode: 0o700 });
const adminToken = readFileSync(config.adminTokenFile, "utf8").trim();
const selection = providerSelection(config);
if (!selection.ok) throw new Error(selection.error);
const providers = new Map<ProviderKind, PhoneProvider>();
function providerFor(kind: ProviderKind) {
  const existing = providers.get(kind);
  if (existing) return { ok: true as const, value: existing };
  const result = loadProvider(kind, config);
  if (result.ok) providers.set(kind, result.value);
  return result;
}
const selected = selection.value === null ? null : providerFor(selection.value);
if (selected && !selected.ok) throw new Error(selected.error);
const provider = selected?.ok ? selected.value : null;
const publicBase = config.publicBaseUrl?.replace(/\/$/, "") ?? "";
const localPort = Number(config.localPort ?? 8802);
const publicPort = Number(config.publicPort ?? 8803);
const voiceBase = config.voiceUrl ?? "http://127.0.0.1:8796";
const owner = config.owner ?? "kenan";
const db = new Database(join(state, "calls.sqlite3"));
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,provider_id TEXT,voice_id TEXT,status TEXT NOT NULL,brief TEXT NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER,error TEXT,cleanup INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,call_id TEXT NOT NULL,at INTEGER NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL);`);
if (!(db.query("PRAGMA table_info(calls)").all() as { name: string }[]).some(c => c.name === "gateway_id")) db.exec("ALTER TABLE calls ADD COLUMN gateway_id TEXT");
if (!(db.query("PRAGMA table_info(calls)").all() as { name: string }[]).some(c => c.name === "provider_kind")) db.exec("ALTER TABLE calls ADD COLUMN provider_kind TEXT; UPDATE calls SET provider_kind='vonage' WHERE provider_id IS NOT NULL AND gateway_id IS NULL");
if (!(db.query("PRAGMA table_info(calls)").all() as { name: string }[]).some(c => c.name === "dial_state")) db.exec("ALTER TABLE calls ADD COLUMN dial_state TEXT NOT NULL DEFAULT 'none'");
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
type Call = { id: string; providerKind: ProviderKind | null; dialState: "none" | "dispatching" | "accepted" | "uncertain" | "rejected"; stream?: CompatibilityMediaSession; streamTimer?: ReturnType<typeof setTimeout>; providerReserved?: boolean; browserReady?: boolean; openingSent?: boolean; gatewayId?: string; telephoneConnected?: boolean; brief: CallBrief; token: string; providerToken: string; page?: Page; media?: Socket; provider?: Socket; voiceId?: string; providerId?: string; offerPending?: boolean; timer: ReturnType<typeof setTimeout>; ready: Promise<void>; resolveReady: () => void; rejectReady: (e: Error) => void; audio: Promise<void>; resolveAudio: () => void; audioOutputBytes: number; usageSeconds: number; finishing?: Promise<void> };
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
    } else if (["ended", "failed"].includes(state)) void finish(c, state === "ended" ? "completed" : "failed", reason);
    else db.query("UPDATE calls SET status=? WHERE id=?").run(state, id);
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
function telephoneInstructions(call: Call) { if (!provider) throw new Error("No selected PSTN provider"); return mediaInstructions(provider, publicBase, call.providerToken, call.id); }
function connected(call: Call) {
  if (call.finishing) return;
  call.telephoneConnected = true;
  db.query("UPDATE calls SET status='connected' WHERE id=?").run(call.id);
  if (!call.browserReady || call.openingSent || !call.media) return;
  call.openingSent = true;
  try { if (call.media.send(JSON.stringify({ type: "context", text: "The telephone connection is now live. Deliver the approved opening and listen." })) === 0) void finish(call, "failed", "Opening dispatch dropped"); }
  catch { void finish(call, "failed", "Opening dispatch failed"); }
}
type CleanupRow = { id: string; provider_id: string | null; voice_id: string | null; provider_kind: ProviderKind | null; dial_state: string };
function cleanupRow(call: Call): CleanupRow { return { id: call.id, provider_id: call.providerId ?? null, voice_id: call.voiceId ?? null, provider_kind: call.providerKind, dial_state: call.dialState }; }
function bindProviderId(id: string, kind: ProviderKind, providerId: string): boolean {
  const row = db.query("SELECT * FROM calls WHERE id=?").get(id) as CleanupRow & { ended_at: number | null; cleanup: number } | null;
  if (!row || row.provider_kind !== kind || (row.provider_id && row.provider_id !== providerId) || (!row.provider_id && !["dispatching", "uncertain"].includes(row.dial_state))) return false;
  if (row.provider_id === providerId && row.dial_state === "accepted" && row.cleanup === 1) return true;
  db.query("UPDATE calls SET provider_id=?,dial_state='accepted',cleanup=0 WHERE id=?").run(providerId, id);
  const c = active.get(id);
  if (c) { c.providerId = providerId; c.dialState = "accepted"; }
  if (row.ended_at !== null) void cleanup({ ...row, provider_id: providerId, dial_state: "accepted" });
  return true;
}
async function voice(path: string, method: string, body: unknown) {
  try { const response = await fetch(`${voiceBase}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(35_000) }); const value = await response.json(); return response.ok ? { ok: true as const, value } : { ok: false as const, error: String(value.error ?? "Voice request failed") }; }
  catch { return { ok: false as const, error: "Voice service unavailable" }; }
}
async function cleanup(row: CleanupRow) {
  const p = row.provider_kind ? providerFor(row.provider_kind) : null;
  const telephone = row.provider_id ? (p?.ok ? p.value.client.hangup(row.provider_id) : { ok: false, error: p && !p.ok ? p.error : "Stored PSTN provider is missing" }) : row.provider_kind && ["dispatching", "uncertain"].includes(row.dial_state) ? { ok: false, error: "Dial outcome unknown; awaiting a signed provider callback, never redialing" } : { ok: true };
  const results = await Promise.all([telephone, row.voice_id ? voice(`/sessions/${encodeURIComponent(row.voice_id)}`, "DELETE", { owner, threadId: `phone:${row.id}` }) : { ok: true }]);
  const failures = results.filter(r => !r.ok).map(r => "error" in r ? r.error : "cleanup failed");
  if (!failures.length) db.query("UPDATE calls SET cleanup=1 WHERE id=?").run(row.id);
  else { db.query("UPDATE calls SET error=?,cleanup=0 WHERE id=?").run(failures.join("; "), row.id); console.error(`Phone call ${row.id}: cleanup pending`); }
}
async function finish(call: Call, status: string, reason?: string) {
  if (call.finishing) return call.finishing;
  call.finishing = Promise.resolve().then(async () => {
    clearTimeout(call.timer);
    clearTimeout(call.streamTimer);
    call.stream?.close();
    if (call.gatewayId) gateways.end(call.gatewayId, call.id);
    db.query("UPDATE calls SET status=?,ended_at=?,error=? WHERE id=?").run(status, Date.now(), reason ?? null, call.id);
    call.rejectReady(new Error(reason ?? "Call ended"));
    try { call.media?.send(JSON.stringify({ type: "close" })); } catch { log(call.id, "cleanup-notice", { error: "Media close notification failed" }); }
    for (const socket of [call.media, call.provider]) try { socket?.close(); } catch { log(call.id, "cleanup-notice", { error: "Audio socket was already closed" }); }
    await call.page?.close().catch(() => {});
    if (call.voiceId) { const usage = await voice(`/sessions/${encodeURIComponent(call.voiceId)}`, "PATCH", { owner, threadId: `phone:${call.id}`, seconds: call.usageSeconds, finalized: false }); if (!usage.ok) log(call.id, "usage-error", { error: usage.error }); }
    await cleanup(cleanupRow(call));
    active.delete(call.id);
  });
  return call.finishing;
}
function create(brief: CallBrief, providerId?: string, id = randomUUID(), gatewayId?: string, providerKind: ProviderKind | null = null): Call {
  let resolveReady!: () => void, rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  let resolveAudio!: () => void;
  const audio = new Promise<void>(resolve => { resolveAudio = resolve; });
  const call: Call = { id, providerKind, dialState: providerId ? "accepted" : "none", gatewayId, brief, audio, resolveAudio, audioOutputBytes: 0, usageSeconds: 0, token: randomBytes(32).toString("base64url"), providerToken: randomBytes(32).toString("base64url"), providerId, ready, resolveReady, rejectReady, timer: setTimeout(() => void finish(call, "completed", "Maximum call duration reached"), (brief.maxSeconds ?? 300) * 1000) };
  db.query("INSERT INTO calls(id,provider_id,status,brief,started_at,gateway_id,provider_kind,dial_state) VALUES(?,?,?,?,?,?,?,?)").run(id, providerId ?? null, "preparing", JSON.stringify(brief), Date.now(), gatewayId ?? null, providerKind, call.dialState); active.set(id, call);
  return call;
}
async function start(call: Call, shouldDial = true) {
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
    if (shouldDial && !call.providerId) {
      db.query("UPDATE calls SET status='dialing' WHERE id=?").run(call.id);
      if (call.gatewayId) {
        const result = gateways.dial(call.gatewayId, call.id, call.brief.to, call.brief.maxSeconds ?? 300);
        if (!result.ok) await finish(call, "failed", result.error);
        return;
      }
      if (!provider || provider.kind !== call.providerKind) { await finish(call, "failed", "PSTN provider is not configured"); return; }
      call.dialState = "dispatching";
      db.query("UPDATE calls SET dial_state='dispatching',cleanup=0 WHERE id=?").run(call.id);
      const result = await dial(provider, call.brief.to, publicBase, call.providerToken, call.id);
      if (!result.ok) {
        if (!call.providerId) { call.dialState = result.uncertain ? "uncertain" : "rejected"; db.query("UPDATE calls SET dial_state=? WHERE id=?").run(call.dialState, call.id); }
        await finish(call, "failed", result.error); return;
      }
      if (!bindProviderId(call.id, provider.kind, result.value.uuid)) { await provider.client.hangup(result.value.uuid); await finish(call, "failed", "Provider call identity changed during dial"); return; }
      call.providerId = result.value.uuid; call.dialState = "accepted";
      if (call.finishing) await cleanup(cleanupRow(call));
    }
  } catch (e) { await finish(call, "failed", e instanceof Error ? e.message.slice(0, 300) : "Audio startup failed"); }
}
const socketOptions = {
  maxPayloadLength: 256 * 1024,
  idleTimeout: 60,
  open(ws: Socket) {
    if (ws.data.side === "gateway") { gateways.connected(ws.data.gatewayId!, ws); return; }
    if (ws.data.side === "provider") {
      const c = ws.data.call!;
      if (c.finishing) { ws.close(); return; }
      c.provider = ws;
      if (isCompatibility(c.providerKind)) {
        const p = providerFor(c.providerKind);
        if (!p.ok || p.value.kind === "vonage") { void finish(c, "failed", "Compatibility provider is unavailable"); return; }
        c.stream = new CompatibilityMediaSession(c.providerKind, c.providerId ?? null, p.value.client.settings.accountSid);
        c.streamTimer = setTimeout(() => void finish(c, "failed", "Compatibility stream startup timed out"), 5000);
      } else connected(c);
    }
  },
  message(ws: Socket, message: string | Buffer) {
    if (ws.data.side === "gateway") { gateways.receive(ws.data.gatewayId!, ws, message); return; }
    if (ws.data.side === "browser" && !ws.data.call) {
      if (typeof message !== "string") { ws.close(1008); return; }
      try { const m = JSON.parse(message); const c = [...active.values()].find(c => same(m.token, c.token)); if (m.type !== "authenticate" || !c || c.media || c.finishing) { ws.close(1008); return; } ws.data.call = c; c.media = ws; return; } catch { ws.close(1008); return; }
    }
    const c = ws.data.call; if (!c || c.finishing) return;
    if (ws.data.side === "provider" && isCompatibility(c.providerKind)) {
      const result = c.stream!.receive(message);
      if (!result.ok) { void finish(c, "failed", `Compatibility stream: ${result.error}`); return; }
      const event = result.value;
      if (event.event === "start") {
        if (!bindProviderId(c.id, c.providerKind, event.callSid)) { void finish(c, "failed", "Compatibility stream call identity mismatch"); return; }
        clearTimeout(c.streamTimer); connected(c);
      } else if (event.event === "media") {
        for (const packet of event.pcm) if (c.media) {
          try { if (c.media.getBufferedAmount() >= 6400 || c.media.send(packet) === 0) { void finish(c, "failed", "Compatibility input backpressure"); return; } }
          catch { void finish(c, "failed", "Compatibility input dispatch failed"); return; }
        }
      } else if (event.event === "stop") void finish(c, "completed", "Compatibility stream stopped");
      return;
    }
    if (typeof message !== "string") { if (ws.data.side === "browser") { c.audioOutputBytes += message.length; let speechSamples = 0; for (let i = 0; i + 1 < message.length; i += 2) if (Math.abs(message.readInt16LE(i)) > 300) speechSamples++; if (speechSamples > 20) c.resolveAudio(); } if (message.length > 6400 || message.length % 2) { void finish(c, "failed", "Invalid telephone audio packet"); return; } if (ws.data.side === "browser" && c.gatewayId) { gateways.audio(c.gatewayId, c.id, message); return; }
    if (ws.data.side === "browser" && isCompatibility(c.providerKind)) {
      if (!c.telephoneConnected || !c.provider || !c.stream) return;
      const result = c.stream.outgoing(message);
      if (!result.ok) { void finish(c, "failed", `Compatibility output: ${result.error}`); return; }
      for (const packet of result.value) {
        try { if (c.provider.getBufferedAmount() >= 6400 || c.provider.send(JSON.stringify(packet)) === 0) { void finish(c, "failed", "Compatibility output backpressure"); return; } }
        catch { void finish(c, "failed", "Compatibility output dispatch failed"); return; }
      }
      return;
    }
    const target = ws.data.side === "provider" ? c.media : c.provider; if (target) {
      try {
        if (target.getBufferedAmount() >= 64_000 || target.send(message) === 0) void finish(c, "failed", "Audio transport backpressure");
      } catch { void finish(c, "failed", "Audio transport dispatch failed"); }
    } return; }
    try {
      const m = JSON.parse(message);
      if (ws.data.side === "provider") { if (m.event === "websocket:connected") log(c.id, "connected", {}); return; }
      if (m.type === "ready") { c.browserReady = true; c.resolveReady(); if (c.telephoneConnected) connected(c); }
      if (m.type === "error") void finish(c, "failed", String(m.error).slice(0, 300));
      if (m.type === "live-event") {
        const e = m.event;
        if (typeof e?.type !== "string") return;
        if (["session.input_transcript.delta", "session.output_transcript.delta", "session.output_audio.delta", "session.usage.updated", "session.delegation.created", "session.closed", "error"].includes(e.type) && e.type !== "session.output_audio.delta") log(c.id, e.type, e);
        if (["session.usage.updated", "session.closed"].includes(e.type) && Number.isFinite(e.usage?.seconds)) c.usageSeconds = Math.max(c.usageSeconds, e.usage.seconds);
        if (e.type === "session.delegation.created") c.media?.send(JSON.stringify({ type: "context", text: "No additional information or authority is available for this call. Use the approved brief, or tell the caller that you will ask Hara and note their question." }));
        if (e.type === "session.closed" || e.type === "error") void finish(c, e.type === "error" ? "failed" : "completed", e.type === "error" ? "GPT Live reported an error" : undefined);
      }
    } catch { void finish(c, "failed", "Malformed audio control message"); }
  },
  close(ws: Socket) { if (ws.data.side === "gateway") { gateways.disconnected(ws.data.gatewayId!, ws); return; } const c = ws.data.call; if (c && !c.finishing) void finish(c, "completed", `${ws.data.side} disconnected`); },
};
db.query("UPDATE calls SET status='interrupted',ended_at=?,error='Service restarted; call not replayed' WHERE ended_at IS NULL").run(Date.now());
for (const row of db.query("SELECT id,provider_id,provider_kind,dial_state,voice_id FROM calls WHERE cleanup=0 AND ended_at IS NOT NULL").all() as CleanupRow[]) await cleanup(row);
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
    if (c.finishing) { await cleanup(cleanupRow(c)); return error("Call ended", 410); }
    return json(result.value);
  }
  if (!same(bearer, `Bearer ${adminToken}`)) return error("Owner authorization required", 403);
  if (url.pathname === "/status") return json({ enabled: true, callingEnabled: config.callingEnabled === true, releaseCommit, pstnProvider: provider?.kind ?? null, storedCallerId: provider?.callerId ?? null, model: "gpt-live-1", activeCalls: active.size, simGateways: gateways.snapshots() });
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
  if (url.pathname === "/calls" && req.method === "GET") return json(db.query("SELECT id,provider_id,provider_kind,dial_state,gateway_id,status,started_at,ended_at,error FROM calls ORDER BY started_at DESC LIMIT 50").all());
  if (url.pathname === "/calls" && req.method === "POST") {
    if (!provider || config.callingEnabled !== true) return error("Confirm provider credit and number ownership, then enable calling in host configuration", 409);
    if (stopping || active.size >= 2) return error("Phone service is busy", 409);
    let body; try { body = await req.json(); } catch { return error("JSON required"); }
    const result = callBrief(body); if (!result.ok) return error(result.error);
    if (stopping || active.size >= 2) return error("Phone service is busy", 409);
    const c = create(result.value, undefined, randomUUID(), undefined, provider.kind); void start(c); return json({ id: c.id, status: "preparing" }, 202);
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
const publicListener = Bun.serve<SocketData>({ hostname: "127.0.0.1", port: publicPort, maxRequestBodySize: 64 * 1024, websocket: socketOptions, async fetch(req, server) {
  const url = new URL(req.url);
  if (url.pathname === "/gateway/connect") {
    const gatewayId = gateways.authenticate(req.headers.get("authorization"));
    if (!gatewayId) return error("Gateway device authorization required", 403);
    if (server.upgrade(req, { data: { side: "gateway", gatewayId } })) return;
    return error("Gateway WebSocket required");
  }
  const route = /^\/(vonage|signalwire|twilio)\/(media|answer|events)(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(url.pathname);
  if (!route) return error("Unknown public phone operation", 404);
  const kind = route[1] as ProviderKind;
  if (route[2] === "media") {
    let c: Call | undefined;
    if (kind === "twilio") {
      c = route[3] ? active.get(route[3]) : undefined;
      const p = providerFor(kind);
      if (!c || c.providerKind !== kind || !same(route[4] ?? null, c.providerToken) || !p.ok || p.value.kind === "vonage" || !signedTwilioUpgrade(req.headers.get("x-twilio-signature"), p.value.client.settings.signingKey, `${publicBase}${url.pathname}${url.search}`)) return error("Signed owned Twilio audio connection required", 403);
    } else {
      if (route[3] || route[4]) return error("Unknown public phone operation", 404);
      c = [...active.values()].find(c => c.providerKind === kind && same(req.headers.get("authorization"), `Bearer ${c.providerToken}`));
    }
    if (!c || c.providerReserved || c.finishing || stopping) return error("Unauthorized audio connection", 403);
    c.providerReserved = true;
    if (server.upgrade(req, { data: { side: "provider", call: c } })) return;
    c.providerReserved = false; return error("WebSocket required");
  }
  if (route[4] || (route[3] && route[2] !== "events")) return error("Unknown public phone operation", 404);
  const p = providerFor(kind);
  if (!p.ok) return error("Signed provider webhook required", 403);
  const rawBody = await req.text();
  let body: Record<string, any>;
  if (p.value.kind !== "vonage") {
    const params = new URLSearchParams(rawBody), settings = p.value.client.settings;
    if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded" || !signedCompatibilityWebhook(req.headers.get(settings.signatureHeader), settings.signingKey, `${publicBase}${url.pathname}${url.search}`, params)) return error("Signed Compatibility webhook required", 403);
    if ([...new Set(params.keys())].some(k => params.getAll(k).length !== 1)) return error("Repeated callback fields", 400);
    body = Object.fromEntries(params);
    if (body.AccountSid !== settings.accountSid) return error("Provider account identity mismatch", 403);
    if (typeof body.CallSid !== "string" || !body.CallSid || body.CallSid.length > 200) return error("Call identity required");
  } else {
    if (!signedWebhook(req.headers.get("authorization"), p.value.client.credentials.VONAGE_SIGNATURE_SECRET, Date.now(), rawBody)) return error("Signed Vonage webhook required", 403);
    try { body = JSON.parse(rawBody); } catch { return error("JSON required"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return error("Webhook object required");
    if (typeof body.uuid !== "string" || !body.uuid || body.uuid.length > 200) return error("Call identity required");
  }
  if (req.method !== "POST") return error("POST webhook required", 405);
  const sid = isCompatibility(kind) ? body.CallSid : body.uuid;
  const status = isCompatibility(kind) ? body.CallStatus : body.status;
  if (route[2] === "events") {
    const stored = route[3] ? null : db.query("SELECT id FROM calls WHERE provider_kind=? AND provider_id=?").get(kind, sid) as { id: string } | null;
    const id = route[3] ?? stored?.id;
    if (!id) return json({ accepted: true });
    if (!bindProviderId(id, kind, sid)) return error("Call identity mismatch", 403);
    const c = active.get(id);
    log(id, "provider-status", { provider: kind, status, uuid: sid });
    const terminal = isCompatibility(kind) ? compatibilityTerminal.has(status) : ["completed", "busy", "cancelled", "unanswered", "rejected", "failed", "timeout"].includes(status);
    if (c && terminal) void finish(c, status === "completed" ? "completed" : "failed", status);
    return json({ accepted: true });
  }
  const xml = (text: string) => new Response(text, { headers: { "content-type": "application/xml" } });
  const unavailable = () => isCompatibility(kind) ? xml(compatibilityUnavailable) : json([{ action: "talk", text: "Kenan is unavailable. Please call again later." }]);
  if (provider?.kind !== kind || config.callingEnabled !== true || stopping) return unavailable();
  const to = String(isCompatibility(kind) ? body.To : body.to).replace(/^\+/, "");
  if (to !== provider.callerId.replace(/^\+/, "")) return unavailable();
  const previous = db.query("SELECT id FROM calls WHERE provider_kind=? AND provider_id=?").get(kind, sid) as { id: string } | null;
  if (previous) {
    const c = active.get(previous.id);
    return isCompatibility(kind) ? xml(c && !c.finishing ? telephoneInstructions(c) as string : compatibilityEnded) : json(c && !c.finishing ? telephoneInstructions(c) : []);
  }
  if (active.size >= 2) return unavailable();
  const from = `+${String(isCompatibility(kind) ? body.From : body.from).replace(/^\+/, "")}`;
  if (!/^\+[1-9]\d{7,14}$/.test(from)) return unavailable();
  const c = create({ to: from, purpose: "Receive a call for Hara's AI assistant Kenan and take a message.", shareableFacts: ["You are Kenan, Hara's AI assistant.", "You can take a message for Hara but cannot share her private information or confirm private details."], opening: "Hello, I'm Kenan, Hara's AI assistant. How can I help?", maxSeconds: 300 }, sid, randomUUID(), undefined, kind);
  void start(c);
  return isCompatibility(kind) ? xml(telephoneInstructions(c) as string) : json(telephoneInstructions(c));
} });
const gatewayWatchdog = setInterval(() => gateways.expire(), 1000);
const heartbeat = setInterval(() => { for (const c of active.values()) if (c.voiceId && !c.finishing) void voice(`/sessions/${encodeURIComponent(c.voiceId)}`, "PATCH", { owner, threadId: `phone:${c.id}`, seconds: c.usageSeconds, finalized: false }).then(r => { if (!r.ok) void finish(c, "failed", r.error); }); }, 20_000);
const recover = setInterval(() => { for (const row of db.query("SELECT id,provider_id,provider_kind,dial_state,voice_id FROM calls WHERE cleanup=0 AND ended_at IS NOT NULL").all() as CleanupRow[]) if (!active.has(row.id)) void cleanup(row); }, 60_000);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { if (stopping) return; stopping = true; clearInterval(heartbeat); clearInterval(gatewayWatchdog); clearInterval(recover); void Promise.all([...active.values()].map(c => finish(c, "interrupted", "Phone service stopping"))).then(async () => { await browser?.close(); local.stop(); publicListener.stop(); process.exit(0); }); });
console.log(`Pi Stack Phone ready on loopback ${localPort}/${publicPort}`);
