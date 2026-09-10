import { API_CORS_HEADERS } from "../cors";
import { MeetBrowser } from "./browser";
import { meetIceServers } from "./config";
import type { MeetEnvelope, MeetParticipant, MeetSignal, MeetSnapshot } from "./protocol";

type Member = { participant: MeetParticipant; seen: number; messages: MeetEnvelope[]; frame: Buffer | null };
type Room = {
  id: string; sessionId: string; apiUrl: string; members: Map<string, Member>; seq: number;
  browser: MeetBrowser | null; opening: Promise<void> | null; closed: boolean;
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { ...API_CORS_HEADERS, "cache-control": "no-store" } });
const fail = (error: string, status = 400) => json({ error }, status);
const image = (bytes: Buffer | null) => bytes
  ? new Response(new Uint8Array(bytes), { headers: { ...API_CORS_HEADERS, "content-type": "image/jpeg", "cache-control": "no-store" } })
  : fail("No video frame is available", 404);
const iceServers = meetIceServers();
const snapshot = (room: Room): MeetSnapshot => ({
  id: room.id, sessionId: room.sessionId, apiUrl: room.apiUrl, iceServers, participants: [...room.members.values()].map((member) => member.participant),
  browser: room.browser ? { endpoint: room.browser.endpoint, url: room.browser.page.url() } : null,
});

function signalValue(value: unknown): MeetSignal | null {
  if (!value || typeof value !== "object") return null;
  const signal = value as MeetSignal;
  if (signal.description && (!["offer", "answer"].includes(signal.description.type) || typeof signal.description.sdp !== "string" || !signal.description.sdp.startsWith("v=0"))) return null;
  if (signal.candidate && typeof signal.candidate.candidate !== "string") return null;
  if (signal.streams && (typeof signal.streams !== "object" || Object.entries(signal.streams).some(([id, kind]) => id.length > 128 || !["camera", "screen", "pi-camera", "pi-screen"].includes(kind)))) return null;
  return signal.description || signal.candidate || signal.streams ? signal : null;
}

export class MeetServer {
  private readonly rooms = new Map<string, Room>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly sessionExists: (id: string) => boolean, private readonly openBrowser = MeetBrowser.open) {
    this.timer = setInterval(() => {
      for (const room of this.rooms.values()) for (const member of room.members.values()) {
        if (Date.now() - member.seen > 45_000) this.leave(room, member.participant.id);
      }
    }, 10_000);
    this.timer.unref();
  }

  private leave(room: Room, id: string) {
    const member = room.members.get(id);
    room.members.delete(id);
    if (member?.participant.host) {
      room.closed = true;
      this.rooms.delete(room.id);
      void room.browser?.close().catch((cause) => console.error("Meet browser cleanup failed", cause));
    }
  }

  async close() {
    clearInterval(this.timer);
    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    for (const room of rooms) room.closed = true;
    await Promise.all(rooms.map(async (room) => { await room.opening; await room.browser?.close(); }));
  }

  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (!/^\/v1\/meet(?:\/|$)/.test(url.pathname)) return null;
    try { return await this.route(req, url); }
    catch (cause) { return fail(`Meet request failed: ${String(cause)}`, 500); }
  }

  private async body(req: Request): Promise<Record<string, any> | null> {
    const text = await req.text();
    if (text.length > 150_000) return null;
    try { const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
    catch { return null; }
  }

  private async route(req: Request, url: URL): Promise<Response> {
    const parts = url.pathname.split("/").filter(Boolean);
    const roomId = parts[2];
    if (!roomId && req.method === "POST") {
      const body = await this.body(req);
      if (!body || typeof body.sessionId !== "string" || !this.sessionExists(body.sessionId)) return fail("Choose an active Pi Remote thread");
      if (this.rooms.size >= 16) return fail("This supervisor already has 16 meetings", 409);
      const id = crypto.randomUUID();
      const room: Room = { id, sessionId: body.sessionId, apiUrl: `${url.origin}/v1/meet/${id}`, members: new Map(), seq: 0, browser: null, opening: null, closed: false };
      const participant: MeetParticipant = { id: crypto.randomUUID(), name: String(body.name || "Host").slice(0, 80), host: true };
      room.members.set(participant.id, { participant, seen: Date.now(), messages: [], frame: null });
      this.rooms.set(room.id, room);
      return json({ room: snapshot(room), participant }, 201);
    }
    if (!roomId && req.method === "GET") return json({ rooms: [...this.rooms.values()].map(snapshot) });
    const room = this.rooms.get(roomId ?? "");
    if (!room) return fail("Meeting ended or does not exist", 404);
    if (parts.length === 3 && req.method === "GET") return json(snapshot(room));
    if (parts[3] === "join" && req.method === "POST") {
      const body = await this.body(req);
      if (!body || typeof body.name !== "string" || !body.name.trim()) return fail("Your name is required");
      if (room.members.size >= 12) return fail("This peer-to-peer room is full, maximum 12 people", 409);
      const participant: MeetParticipant = { id: crypto.randomUUID(), name: body.name.trim().slice(0, 80), host: false };
      room.members.set(participant.id, { participant, seen: Date.now(), messages: [], frame: null });
      return json({ room: snapshot(room), participant }, 201);
    }
    if (parts[3] === "browser" && req.method === "GET") return parts[4] === "frame" ? image(room.browser?.frame ?? null) : json(snapshot(room).browser);
    if (parts[3] === "participants" && parts[5] === "frame" && req.method === "GET") return image(room.members.get(parts[4]!)?.frame ?? null);
    const member = room.members.get(url.searchParams.get("participant") ?? "");
    if (!member) return fail("Join the meeting first", 403);
    member.seen = Date.now();
    if (parts[3] === "poll" && req.method === "GET") {
      const after = Number(url.searchParams.get("after") || 0);
      if (!Number.isSafeInteger(after) || after < 0) return fail("Invalid signal cursor");
      member.messages = member.messages.filter((message) => message.seq > after);
      return json({ ...snapshot(room), messages: member.messages });
    }
    if (parts[3] === "leave" && req.method === "POST") { this.leave(room, member.participant.id); return json({ ok: true }); }
    if (parts[3] === "signal" && req.method === "POST") {
      const body = await this.body(req);
      const target = body && room.members.get(body.to);
      const signal = body && signalValue(body.signal);
      if (!target) return fail("Participant has left the meeting", 410);
      if (!signal || target === member) return fail("Invalid signaling message or recipient");
      if (!member.participant.host && Object.values(signal.streams ?? {}).some((kind) => kind.startsWith("pi-"))) return fail("Only the host publishes PiStack streams", 403);
      if (target.messages.length >= 256) return fail("The recipient stopped consuming signaling messages", 409);
      target.messages.push({ seq: ++room.seq, from: member.participant.id, signal });
      return json({ ok: true });
    }
    if (parts[3] === "frame" && req.method === "PUT") {
      if (req.headers.get("content-type") !== "image/jpeg") return fail("A JPEG camera frame is required");
      const bytes = Buffer.from(await req.arrayBuffer());
      if (bytes.length > 512_000 || bytes[0] !== 255 || bytes[1] !== 216) return fail("Invalid or oversized JPEG");
      member.frame = bytes;
      return json({ ok: true });
    }
    if (parts[3] === "browser" && req.method === "POST") {
      if (!member.participant.host) return fail("Only the host controls browser sharing", 403);
      const body = await this.body(req);
      if (!body) return fail("A browser request is required");
      if (!room.browser) {
        let error = "";
        room.opening ??= (async () => {
          const result = await this.openBrowser();
          if (!result.ok) { error = result.error; return; }
          if (room.closed) await result.value.close();
          else room.browser = result.value;
        })();
        await room.opening;
        room.opening = null;
        if (!room.browser) return fail(error || "Browser startup was interrupted", 503);
      }
      if (typeof body.url === "string" && body.url) {
        const result = await room.browser.navigate(body.url);
        if (!result.ok) return fail(result.error, 502);
      }
      return json(snapshot(room).browser);
    }
    return fail("Unknown Meet operation", 404);
  }
}
