import { Database } from "bun:sqlite";
import type { ImageContent } from "@earendil-works/pi-ai";
import { MeetTranscriptStore, transcriptText } from "./transcript";
import { MeetTranscriber } from "./transcriber";
import { API_CORS_HEADERS } from "../cors";
import { MeetBrowser } from "./browser";
import { meetIceServers } from "./config";
import type { MeetEnvelope, MeetParticipant, MeetSignal, MeetSnapshot, MeetThreadState, MeetJoined } from "./protocol";

type Member = { participant: MeetParticipant; seen: number; messages: MeetEnvelope[]; frame: Buffer | null; frameAt: number };
type PendingFlush = { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type Room = {
  id: string; sessionId: string; apiUrl: string; members: Map<string, Member>; speakers: Map<string, MeetParticipant>; seq: number;
  browser: MeetBrowser | null; opening: Promise<void> | null; closed: boolean;
  voiceMuted: boolean; voiceRevision: number; threads(): MeetThreadState[];
  transcriptFlushRevision: number; flushes: Map<number, PendingFlush>;
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { ...API_CORS_HEADERS, "cache-control": "no-store" } });
const fail = (error: string, status = 400) => json({ error }, status);
const image = (bytes: Buffer | null) => bytes
  ? new Response(new Uint8Array(bytes), { headers: { ...API_CORS_HEADERS, "content-type": "image/jpeg", "cache-control": "no-store" } })
  : fail("No video frame is available", 404);
const iceServers = meetIceServers();
const snapshot = (room: Room): MeetSnapshot => ({
  voiceMuted: room.voiceMuted, voiceRevision: room.voiceRevision, threads: room.threads(), transcriptFlushRevision: room.transcriptFlushRevision,
  id: room.id, sessionId: room.sessionId, apiUrl: room.apiUrl, iceServers, participants: [...room.members.values()].map((member) => member.participant),
  browser: room.browser ? { endpoint: room.browser.endpoint, url: room.browser.page.url(), error: room.browser.error, watchPath: room.browser.watchPath, watchError: room.browser.watchError } : null,
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
  constructor(private readonly sessionExists: (id: string) => boolean, private readonly openBrowser = MeetBrowser.open, db?: Database,
    private readonly threadActivity: (meetingId: string, sessionId: string) => MeetThreadState[] = () => []) {
    this.transcripts = new MeetTranscriptStore(db ?? new Database(":memory:"));
    this.transcriber = new MeetTranscriber(this.transcripts);
    this.timer = setInterval(() => {
      for (const room of this.rooms.values()) for (const member of room.members.values()) {
        if (Date.now() - member.seen > 45_000) this.leave(room, member.participant.id);
      }
    }, 10_000);
    this.timer.unref();
  }

  private createRoom(id: string, sessionId: string, apiUrl: string, name: string, participantId: string = crypto.randomUUID()): MeetJoined {
    const room: Room = { id, sessionId, apiUrl, members: new Map(), speakers: new Map(), seq: 0,
      browser: null, opening: null, closed: false, voiceMuted: true, voiceRevision: 0,
      transcriptFlushRevision: 0, flushes: new Map(), threads: () => this.threadActivity(id, sessionId) };
    const participant: MeetParticipant = { id: participantId, name: name.slice(0, 80), host: true };
    room.members.set(participant.id, { participant, seen: Date.now(), messages: [], frame: null, frameAt: 0 });
    room.speakers.set(participant.id, participant);
    if (this.transcripts.has(id)) this.transcripts.resume(id);
    else this.transcripts.create(id, sessionId);
    this.rooms.set(id, room);
    return { room: snapshot(room), participant };
  }

  openExternal(id: string, sessionId: string, apiUrl: string): MeetJoined {
    const room = this.rooms.get(id);
    if (room) {
      const host = [...room.members.values()].find((member) => member.participant.host)!;
      host.seen = Date.now();
      return { room: snapshot(room), participant: host.participant };
    }
    if (this.rooms.size >= 16) throw new Error("This supervisor already has 16 meetings");
    return this.createRoom(id, sessionId, apiUrl, "Mixed meeting audio", "external-host");
  }

  stopExternal(id: string) {
    const room = this.rooms.get(id);
    const host = room && [...room.members.values()].find((member) => member.participant.host);
    if (room && host) this.leave(room, host.participant.id);
    else if (this.transcripts.has(id)) this.transcripts.end(id);
  }

  flushTranscript(id: string): Promise<void> {
    const room = this.rooms.get(id);
    if (!room || room.closed) return Promise.resolve();
    const revision = ++room.transcriptFlushRevision;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        room.flushes.delete(revision);
        reject(new Error("The meeting microphone host did not flush its latest speech; delegation remains queued"));
      }, 20_000);
      room.flushes.set(revision, { resolve, reject, timer });
    });
  }

  private rejectFlushes(room: Room) {
    for (const pending of room.flushes.values()) { clearTimeout(pending.timer); pending.reject(new Error("Meeting host left before its transcript flush completed")); }
    room.flushes.clear();
  }

  private leave(room: Room, id: string) {
    const member = room.members.get(id);
    room.members.delete(id);
    if (member?.participant.host) {
      room.closed = true;
      this.rejectFlushes(room);
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
    for (const room of rooms) { room.closed = true; this.rejectFlushes(room); this.transcripts.end(room.id); }
    await Promise.all(rooms.map(async (room) => { await room.opening; await room.browser?.close(); }));
  }

  captureDelegation(meetingId: string): { images: ImageContent[]; note: string } {
    const room = this.rooms.get(meetingId);
    if (!room) return { images: [], note: "No active meeting camera images are available." };
    const images: ImageContent[] = [];
    const labels: string[] = [];
    const unavailable: string[] = [];
    for (const member of room.members.values()) {
      if (!member.frame || Date.now() - member.frameAt > 10_000) {
        unavailable.push(member.participant.name);
        continue;
      }
      images.push({ type: "image", mimeType: "image/jpeg", data: member.frame.toString("base64") });
      labels.push(`Image ${images.length}: ${member.participant.name}, participant ${member.participant.id}, camera captured at ${new Date(member.frameAt).toISOString()}`);
    }
    return { images, note: [
      ...(images.length ? ["the images might not be relevant to the request, but that is the people in the room.", ...labels] : []),
      ...(unavailable.length ? [`Camera images unavailable: ${unavailable.join(", ")}`] : []),
    ].join("\n") };
  }

  async handleAgent(req: Request, meetingId: string): Promise<Response> {
    const room = this.rooms.get(meetingId);
    if (!room) return fail("Your meeting is not active", 409);
    const host = [...room.members.values()].find((member) => member.participant.host);
    if (!host) return fail("The meeting host has left", 409);
    const source = new URL(req.url);
    if (source.pathname.endsWith("/meeting")) return json(snapshot(room));
    const participant = source.searchParams.get("participant");
    const suffix = source.pathname.endsWith("/frame")
      ? participant ? `/participants/${encodeURIComponent(participant)}/frame` : "/browser/frame"
      : source.pathname.endsWith("/voice") ? "/voice" : "/browser";
    const target = new URL(`/v1/meet/${room.id}${suffix}`, source);
    target.searchParams.set("participant", host.participant.id);
    return (await this.handle(new Request(target, req)))!;
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
      if (!body || typeof body.sessionId !== "string" || !this.sessionExists(body.sessionId)) return fail("The meeting's new Pi Remote thread is unavailable");
      if (typeof body.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.requestId)) return fail("A meeting creation request ID is required");
      const id = body.requestId;
      const existing = this.rooms.get(id);
      if (existing) {
        if (existing.sessionId !== body.sessionId) return fail("Meeting creation request belongs to another thread", 409);
        const participant = [...existing.members.values()].find((member) => member.participant.host)!.participant;
        return json({ room: snapshot(existing), participant }, 201);
      }
      if (this.transcripts.has(id)) return fail("This meeting has ended; start a new meeting", 409);
      if (this.rooms.size >= 16) return fail("This supervisor already has 16 meetings", 409);
      return json(this.createRoom(id, body.sessionId, `${url.origin}/v1/meet/${id}`, String(body.name || "Host")), 201);
    }
    if (!roomId && req.method === "GET") return json({ rooms: [...this.rooms.values()].map(snapshot), meetings: this.transcripts.meetings(url.searchParams.get("sessionId") || undefined), transcriptionAvailable: this.transcriber.available() });
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
      room.members.set(participant.id, { participant, seen: Date.now(), messages: [], frame: null, frameAt: 0 });
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
    if (parts[3] === "transcript" && parts[4] === "flushed" && req.method === "POST") {
      if (!member.participant.host) return fail("Only the host can acknowledge microphone flushes", 403);
      const body = await this.body(req);
      if (!body || !Number.isSafeInteger(body.revision) || body.revision < 1 || body.revision > room.transcriptFlushRevision
        || (body.error !== undefined && typeof body.error !== "string")) return fail("Invalid transcript flush acknowledgement");
      for (const [revision, pending] of room.flushes) if (revision <= body.revision) {
        clearTimeout(pending.timer); room.flushes.delete(revision);
        if (body.error) pending.reject(new Error(`Meeting transcript flush failed: ${body.error.slice(0, 2000)}`));
        else pending.resolve();
      }
      return json({ ok: true });
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
      let fragment: { voiceSessionId: string; startMs: number; endMs: number } | undefined;
      if (body.voiceSessionId !== undefined || body.startMs !== undefined || body.endMs !== undefined) {
        if (typeof body.voiceSessionId !== "string" || !body.voiceSessionId || body.voiceSessionId.length > 200
          || !Number.isFinite(body.startMs) || !Number.isFinite(body.endMs) || body.startMs < 0 || body.endMs < body.startMs) return fail("Invalid Voice transcript interval");
        fragment = { voiceSessionId: body.voiceSessionId, startMs: body.startMs, endMs: body.endMs };
      }
      this.transcripts.assistant(`${room.id}:pi:${body.id}`, room.id, body.text, body.final, body.startedAt, fragment);
      return json({ ok: true });
    }
    if (parts[3] === "transcript" && parts[4] === "retry" && req.method === "POST") {
      if (!member.participant.host) return fail("Only the host can retry transcription", 403);
      this.transcripts.retry(room.id); this.transcriber.wake(); return json({ ok: true });
    }
    if (parts[3] === "voice" && req.method === "POST") {
      if (!member.participant.host) return fail("Only the host or Kenan controls Voice output", 403);
      const body = await this.body(req);
      if (typeof body?.muted !== "boolean") return fail("muted must be a boolean");
      if (room.voiceMuted !== body.muted) { room.voiceMuted = body.muted; room.voiceRevision++; }
      return json({ muted: room.voiceMuted, revision: room.voiceRevision });
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
    if (parts[3] === "frame" && req.method === "DELETE") {
      member.frame = null; member.frameAt = 0;
      return json({ ok: true });
    }
    if (parts[3] === "frame" && req.method === "PUT") {
      if (req.headers.get("content-type") !== "image/jpeg") return fail("A JPEG camera frame is required");
      const bytes = Buffer.from(await req.arrayBuffer());
      if (bytes.length > 512_000 || bytes[0] !== 255 || bytes[1] !== 216) return fail("Invalid or oversized JPEG");
      member.frame = bytes;
      member.frameAt = Date.now();
      return json({ ok: true });
    }
    if (parts[3] === "browser" && req.method === "DELETE") {
      if (!member.participant.host) return fail("Only the host controls browser sharing", 403);
      await room.opening;
      const browser = room.browser;
      room.browser = null;
      await browser?.close();
      return json({ sharing: false });
    }
    if (parts[3] === "browser" && req.method === "POST") {
      if (!member.participant.host) return fail("Only the host controls browser sharing", 403);
      const body = await this.body(req);
      if (!body) return fail("A browser request is required");
      if (body.watch !== undefined && body.watch !== null && typeof body.watch !== "string") return fail("watch must be a directory path or null");
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
      if (body.watch !== undefined) {
        const result = await room.browser.setWatch(body.watch);
        if (!result.ok) return fail(result.error);
      }
      return json(snapshot(room).browser);
    }
    return fail("Unknown Meet operation", 404);
  }
}
