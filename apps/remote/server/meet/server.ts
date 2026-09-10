import { Database } from "bun:sqlite";
import { MeetTranscriptStore, transcriptText } from "./transcript";
import { MeetTranscriber } from "./transcriber";
import { API_CORS_HEADERS } from "../cors";
import { MeetBrowser } from "./browser";
import { meetIceServers } from "./config";
import type { MeetEnvelope, MeetParticipant, MeetSignal, MeetSnapshot } from "./protocol";

type Member = { participant: MeetParticipant; seen: number; messages: MeetEnvelope[]; frame: Buffer | null };
type Room = {
  id: string; sessionId: string; apiUrl: string; members: Map<string, Member>; speakers: Map<string, MeetParticipant>; seq: number;
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
  readonly transcripts: MeetTranscriptStore;
  private readonly transcriber: MeetTranscriber;
  constructor(private readonly sessionExists: (id: string) => boolean, private readonly openBrowser = MeetBrowser.open, db?: Database) {
    this.transcripts = new MeetTranscriptStore(db ?? new Database(":memory:"));
    this.transcriber = new MeetTranscriber(this.transcripts);
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
      this.transcripts.end(room.id);
      this.rooms.delete(room.id);
      void room.browser?.close().catch((cause) => console.error("Meet browser cleanup failed", cause));
    }
  }

  async close() {
    clearInterval(this.timer);
    this.transcriber.close();
    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    for (const room of rooms) { room.closed = true; this.transcripts.end(room.id); }
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
      const room: Room = { id, sessionId: body.sessionId, apiUrl: `${url.origin}/v1/meet/${id}`, members: new Map(), speakers: new Map(), seq: 0, browser: null, opening: null, closed: false };
      const participant: MeetParticipant = { id: crypto.randomUUID(), name: String(body.name || "Host").slice(0, 80), host: true };
      room.members.set(participant.id, { participant, seen: Date.now(), messages: [], frame: null });
      room.speakers.set(participant.id, participant);
      this.transcripts.create(room.id, room.sessionId);
      this.rooms.set(room.id, room);
      return json({ room: snapshot(room), participant }, 201);
    }
    if (!roomId && req.method === "GET") return json({ rooms: [...this.rooms.values()].map(snapshot), meetings: this.transcripts.meetings(url.searchParams.get("sessionId") || ""), transcriptionAvailable: this.transcriber.available() });
    if (roomId && parts[3] === "transcript" && parts.length === 4 && req.method === "GET") {
      if (!this.transcripts.has(roomId)) return fail("Meeting transcript not found", 404);
      const turns = this.transcripts.read(roomId);
      return url.searchParams.get("format") === "text"
        ? new Response(transcriptText(turns), { headers: { ...API_CORS_HEADERS, "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="meet-${roomId}.txt"`, "cache-control": "no-store" } })
        : json({ turns });
    }
    const room = this.rooms.get(roomId ?? "");
    if (!room) {
      if (roomId && this.transcripts.has(roomId) && parts[3] === "transcript" && parts[4] === "retry" && req.method === "POST") {
        this.transcripts.retry(roomId); this.transcriber.wake(); return json({ ok: true });
      }
      return fail("Meeting ended or does not exist", 404);
    }
    if (parts.length === 3 && req.method === "GET") return json(snapshot(room));
    if (parts[3] === "join" && req.method === "POST") {
      const body = await this.body(req);
      if (!body || typeof body.name !== "string" || !body.name.trim()) return fail("Your name is required");
      if (room.members.size >= 12) return fail("This peer-to-peer room is full, maximum 12 people", 409);
      const participant: MeetParticipant = { id: crypto.randomUUID(), name: body.name.trim().slice(0, 80), host: false };
      room.members.set(participant.id, { participant, seen: Date.now(), messages: [], frame: null });
      room.speakers.set(participant.id, participant);
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
    if (parts[3] === "transcript" && parts[4] === "audio" && req.method === "POST") {
      if (!this.transcriber.available()) return fail("PiStack transcription is not installed on this host", 503);
      const speakerId = url.searchParams.get("speaker") || member.participant.id;
      const speaker = room.speakers.get(speakerId);
      if (!speaker || (speakerId !== member.participant.id && !member.participant.host)) return fail("Unknown microphone source", 403);
      const id = url.searchParams.get("id") || "";
      const startedAt = Number(url.searchParams.get("startedAt"));
      if (!/^[0-9a-f-]{36}$/.test(id) || !Number.isFinite(startedAt) || startedAt < 0) return fail("Invalid utterance identity or timestamp");
      if (this.transcripts.countPending() >= 128) return fail("Transcription queue is full; microphone capture must pause", 429);
      const audio = new Uint8Array(await req.arrayBuffer());
      if (req.headers.get("content-type") !== "audio/pcm" || audio.length < 2 || audio.length > 512_000 || audio.length % 2) return fail("16 kHz mono signed little-endian PCM16 audio required, maximum 16 seconds");
      const key = `${room.id}:${speakerId}:${id}`;
      if (!this.transcripts.enqueue(key, room.id, speakerId, speaker.name, startedAt, audio)) return fail("Utterance identity conflict", 409);
      this.transcriber.wake();
      return json({ id: key }, 202);
    }
    if (parts[3] === "transcript" && parts[4] === "assistant" && req.method === "POST") {
      if (!member.participant.host) return fail("Only the host records Voice output", 403);
      const body = await this.body(req);
      if (!body || typeof body.id !== "string" || !body.id || body.id.length > 200 || typeof body.text !== "string" || typeof body.final !== "boolean" || !Number.isFinite(body.startedAt)) return fail("Invalid Voice turn");
      this.transcripts.assistant(`${room.id}:pi:${body.id}`, room.id, body.text, body.final, body.startedAt);
      return json({ ok: true });
    }
    if (parts[3] === "transcript" && parts[4] === "retry" && req.method === "POST") {
      if (!member.participant.host) return fail("Only the host can retry transcription", 403);
      this.transcripts.retry(room.id); this.transcriber.wake(); return json({ ok: true });
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
