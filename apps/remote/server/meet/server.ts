import { Database } from "bun:sqlite";
import type { ImageContent } from "@earendil-works/pi-ai";
import { MeetTranscriptStore, transcriptText } from "./transcript";
import { MeetTranscriber } from "./transcriber";
import { API_CORS_HEADERS } from "../cors";
import { MeetBrowser } from "./browser";
import { addressesAgent } from "./mention";
import { TranscriptHook } from "./transcript-hook";
import type { MeetParticipant, MeetSnapshot, MeetThreadState, MeetJoined, MeetVoiceWake } from "./protocol";

type Member = { participant: MeetParticipant; seen: number; frame: Buffer | null; frameAt: number };
type PendingFlush = { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type Room = {
  id: string; sessionId: string; apiUrl: string; members: Map<string, Member>;
  browser: MeetBrowser | null; opening: Promise<void> | null; closed: boolean;
  voiceMuted: boolean; voiceRevision: number; threads(): MeetThreadState[];
  /** Latest transcript line naming Kenan, and the platform turns that already produced one, so partial updates wake Voice once. */
  voiceWake: MeetVoiceWake | null; wokenTurns: Set<string>;
  /** Final platform turns already handed to the host's transcript hook. */
  hookedTurns: Set<string>;
  transcriptFlushRevision: number; flushes: Map<number, PendingFlush>;
  /** The meeting platform supplies speaker-labelled turns, so the host's mixed audio is not recognized locally. */
  platformTranscript: boolean;
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { ...API_CORS_HEADERS, "cache-control": "no-store" } });
const fail = (error: string, status = 400) => json({ error }, status);
const image = (bytes: Buffer | null) => bytes
  ? new Response(new Uint8Array(bytes), { headers: { ...API_CORS_HEADERS, "content-type": "image/jpeg", "cache-control": "no-store" } })
  : fail("No video frame is available", 404);
const snapshot = (room: Room): MeetSnapshot => ({
  voiceMuted: room.voiceMuted, voiceRevision: room.voiceRevision, voiceWake: room.voiceWake, threads: room.threads(), transcriptFlushRevision: room.transcriptFlushRevision,
  platformTranscript: room.platformTranscript,
  id: room.id, sessionId: room.sessionId, apiUrl: room.apiUrl, participants: [...room.members.values()].map((member) => member.participant),
  browser: room.browser ? { endpoint: room.browser.endpoint, url: room.browser.page.url(), error: room.browser.error, watchPath: room.browser.watchPath, watchError: room.browser.watchError } : null,
});

export class MeetServer {
  private readonly rooms = new Map<string, Room>();
  private readonly timer: ReturnType<typeof setInterval>;
  readonly transcripts: MeetTranscriptStore;
  private readonly transcriber: MeetTranscriber;
  constructor(private readonly sessionExists: (id: string) => boolean, private readonly openBrowser = MeetBrowser.open, db?: Database,
    private readonly threadActivity: (meetingId: string, sessionId: string) => MeetThreadState[] = () => [],
    private readonly transcriptHook = new TranscriptHook(),
    private readonly roomLifecycle: (event: { kind: "created"; id: string; sessionId: string } | { kind: "closed"; id: string }) => void = () => {}) {
    this.transcripts = new MeetTranscriptStore(db ?? new Database(":memory:"));
    this.transcriber = new MeetTranscriber(this.transcripts);
    this.timer = setInterval(() => {
      for (const room of this.rooms.values()) for (const member of room.members.values()) {
        if (Date.now() - member.seen > 45_000) this.leave(room, member.participant.id);
      }
    }, 10_000);
    this.timer.unref();
  }

  private createRoom(id: string, sessionId: string, apiUrl: string, platformTranscript: boolean): MeetJoined {
    const room: Room = { id, sessionId, apiUrl, members: new Map(),
      browser: null, opening: null, closed: false, voiceMuted: true, voiceRevision: 0, voiceWake: null, wokenTurns: new Set(), hookedTurns: new Set(),
      transcriptFlushRevision: 0, flushes: new Map(), platformTranscript, threads: () => this.threadActivity(id, sessionId) };
    const participant: MeetParticipant = { id: "external-host", name: "Mixed meeting audio", host: true };
    room.members.set(participant.id, { participant, seen: Date.now(), frame: null, frameAt: 0 });
    this.transcripts.db.transaction(() => {
      if (this.transcripts.has(id)) this.transcripts.resume(id);
      else this.transcripts.create(id, sessionId);
      this.roomLifecycle({ kind: "created", id, sessionId });
    })();
    this.rooms.set(id, room);
    return { room: snapshot(room), participant };
  }

  openExternal(id: string, sessionId: string, apiUrl: string, platformTranscript = false): MeetJoined {
    if (!this.sessionExists(sessionId)) throw new Error("The external meeting's Pi Remote thread is unavailable");
    const room = this.rooms.get(id);
    if (room) {
      if (room.sessionId !== sessionId) throw new Error("Meeting belongs to another thread");
      const host = [...room.members.values()].find((member) => member.participant.host)!;
      host.seen = Date.now();
      room.platformTranscript = platformTranscript;
      return { room: snapshot(room), participant: host.participant };
    }
    if (this.rooms.size >= 16) throw new Error("This supervisor already has 16 meetings");
    return this.createRoom(id, sessionId, apiUrl, platformTranscript);
  }

  liveRooms(): Array<{ id: string; sessionId: string }> {
    return [...this.rooms.values()].filter(room => !room.closed).map(({ id, sessionId }) => ({ id, sessionId }));
  }

  /** Whether this meeting has an open room, so its threads must stay reachable. */
  isLive(id: string): boolean {
    const room = this.rooms.get(id);
    return Boolean(room && !room.closed);
  }

  stopExternal(id: string) {
    const room = this.rooms.get(id);
    const host = room && [...room.members.values()].find((member) => member.participant.host);
    if (room && host) this.leave(room, host.participant.id);
    else if (this.transcripts.has(id)) this.transcripts.end(id);
  }

  flushTranscript(id: string): Promise<void> {
    const room = this.rooms.get(id);
    // A platform room's host uploads no audio, so there is nothing to flush; waiting on its next poll only delayed every handoff.
    if (!room || room.closed || room.platformTranscript) return Promise.resolve();
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
    if (member?.participant.host) {
      this.transcripts.db.transaction(() => {
        this.transcripts.end(room.id);
        this.roomLifecycle({ kind: "closed", id: room.id });
      })();
      room.closed = true;
      this.rejectFlushes(room);
      this.rooms.delete(room.id);
      void room.browser?.close().catch((cause) => console.error("Meet browser cleanup failed", cause));
    }
    room.members.delete(id);
  }

  async close() {
    clearInterval(this.timer);
    this.transcriber.close();
    const rooms = [...this.rooms.values()];
    this.transcripts.db.transaction(() => {
      for (const room of rooms) {
        this.transcripts.end(room.id);
        this.roomLifecycle({ kind: "closed", id: room.id });
      }
    })();
    this.rooms.clear();
    for (const room of rooms) { room.closed = true; this.rejectFlushes(room); }
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
    if (!roomId && req.method === "POST") return fail("Unknown Meet operation", 404);
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
      if (room.members.size >= 33) return fail("This external room is full, maximum 32 camera sources plus the host", 409);
      const participant: MeetParticipant = { id: crypto.randomUUID(), name: body.name.trim().slice(0, 80), host: false };
      room.members.set(participant.id, { participant, seen: Date.now(), frame: null, frameAt: 0 });
      return json({ room: snapshot(room), participant }, 201);
    }
    if (parts[3] === "browser" && req.method === "GET") return parts[4] === "frame" ? image(room.browser?.frame ?? null) : json(snapshot(room).browser);
    if (parts[3] === "participants" && parts[5] === "frame" && req.method === "GET") return image(room.members.get(parts[4]!)?.frame ?? null);
    const member = room.members.get(url.searchParams.get("participant") ?? "");
    if (!member) return fail("Join the meeting first", 403);
    member.seen = Date.now();
    if (parts[3] === "poll" && req.method === "GET") return json(snapshot(room));
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
      if (!member.participant.host) return fail("Only the external host supplies mixed meeting audio", 403);
      if (room.platformTranscript) return fail("This meeting uses the platform transcript", 409);
      const speakerId = url.searchParams.get("speaker") || member.participant.id;
      if (speakerId !== member.participant.id) return fail("Unknown mixed meeting audio source", 403);
      if (!this.transcriber.available()) return fail("Meeting recognition is not installed on this host", 503);
      const speaker = member.participant;
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
    if (parts[3] === "transcript" && parts[4] === "turn" && req.method === "POST") {
      if (!member.participant.host) return fail("Only the host records platform transcript turns", 403);
      const body = await this.body(req);
      if (!body || typeof body.id !== "string" || !body.id || body.id.length > 200
        || typeof body.speakerId !== "string" || !body.speakerId || body.speakerId.length > 200 || body.speakerId === "pi" || room.members.has(body.speakerId)
        || typeof body.speaker !== "string" || !body.speaker.trim() || typeof body.text !== "string" || body.text.length > 20_000
        || !Number.isFinite(body.startedAt) || body.startedAt < 0 || (body.final !== undefined && typeof body.final !== "boolean")) return fail("Invalid platform transcript turn");
      if (!this.transcripts.platform(`${room.id}:platform:${body.id}`, room.id, body.speakerId, body.speaker.trim().slice(0, 120), body.startedAt, body.text, body.final ?? true)) {
        return fail("Platform transcript turn identity conflict", 409);
      }
      if (!room.wokenTurns.has(body.id) && addressesAgent(body.text)) {
        if (room.wokenTurns.size >= 1_000) room.wokenTurns.clear();
        room.wokenTurns.add(body.id);
        room.voiceWake = { revision: (room.voiceWake?.revision ?? 0) + 1, turnId: body.id, speaker: body.speaker.trim().slice(0, 120),
          text: body.text.slice(0, 2_000), at: Date.now() };
      }
      if ((body.final ?? true) && !room.hookedTurns.has(body.id)) {
        if (room.hookedTurns.size >= 1_000) room.hookedTurns.clear();
        room.hookedTurns.add(body.id);
        void this.transcriptHook.deliver({ roomId: room.id, sessionId: room.sessionId, id: body.id, speaker: body.speaker.trim().slice(0, 120),
          speakerId: body.speakerId, text: body.text.slice(0, 2_000), startedAt: body.startedAt });
      }
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
