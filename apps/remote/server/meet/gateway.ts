import { Database } from "bun:sqlite";
import type { ImageContent } from "@earendil-works/pi-ai";
import { resolve, join } from "node:path";
import { API_CORS_HEADERS } from "../cors";
import { MeetTranscriptStore } from "./transcript";
import { connectRuntime, initializeRuntimeMirror, meetData, meetSocket, runtimeCall } from "./runtime";
import type { RuntimeContext, RuntimeRequest, RuntimeResponse, RuntimeStatus } from "./runtime";
import type { MeetJoined, MeetResult, MeetThreadState } from "./protocol";

export type MeetGatewayCallbacks = { sessionExists(id: string): boolean; threadActivity(meetingId: string, sessionId: string): MeetThreadState[] };
const unavailable = (error: string) => Response.json({ error }, { status: 503, headers: API_CORS_HEADERS });

export class MeetGateway {
  readonly transcripts: MeetTranscriptStore;
  private constructor(private readonly db: Database, private readonly callbacks: MeetGatewayCallbacks,
    private readonly socket: string, readonly runtime: RuntimeStatus) {
    this.transcripts = new MeetTranscriptStore(db);
  }

  static async connect(db: Database, callbacks: MeetGatewayCallbacks): Promise<MeetResult<MeetGateway>> {
    try {
      const data = meetData();
      if (resolve(db.filename) !== resolve(join(data, "supervisor.sqlite3"))) {
        return { ok: false, error: "Meet runtime must share the person's supervisor.sqlite3 under PI_REMOTE_DATA" };
      }
      initializeRuntimeMirror(db);
      const runtime = await connectRuntime(data);
      if (!runtime.ok) return runtime;
      return { ok: true, value: new MeetGateway(db, callbacks, meetSocket(data), runtime.value) };
    } catch (cause) { return { ok: false, error: `Meet gateway connection failed: ${String(cause)}` }; }
  }

  isLive(id: string): boolean {
    const owner = this.db.query("SELECT pid,instance FROM meet_runtime_owner WHERE singleton=1").get() as { pid: number; instance: string } | null;
    if (!owner) return false;
    try { process.kill(owner.pid, 0); } catch { return false; }
    return Boolean(this.db.query("SELECT 1 FROM meet_live_rooms WHERE id=? AND instance=?").get(id, owner.instance));
  }

  private context(sessions: string[] = [], extra?: { meetingId: string; sessionId: string }): RuntimeContext {
    const rooms = this.db.query("SELECT id AS meetingId,session_id AS sessionId FROM meet_live_rooms").all() as Array<{ meetingId: string; sessionId: string }>;
    if (extra && !rooms.some(room => room.meetingId === extra.meetingId)) rooms.push(extra);
    return { sessions: sessions.filter(id => this.callbacks.sessionExists(id)),
      activity: rooms.map(room => ({ ...room, threads: this.callbacks.threadActivity(room.meetingId, room.sessionId) })) };
  }

  private async proxy(req: Request, agentMeetingId: string | null): Promise<Response> {
    try {
      const input: RuntimeRequest = { url: req.url, method: req.method, headers: [...req.headers],
        body: req.body === null ? null : Buffer.from(await req.arrayBuffer()).toString("base64"), agentMeetingId, context: this.context() };
      const result = await runtimeCall<RuntimeResponse>(this.socket, "/runtime/request", input, 120_000);
      if (!result.ok) return unavailable(result.error);
      const output = result.value;
      if (!output || !Number.isInteger(output.status) || output.status < 200 || output.status > 599 || !Array.isArray(output.headers) || typeof output.body !== "string") {
        return unavailable("Meet runtime returned an invalid response envelope");
      }
      return new Response([204, 205, 304].includes(output.status) ? null : Buffer.from(output.body, "base64"), { status: output.status, headers: output.headers });
    } catch (cause) { return unavailable(`Meet gateway request failed: ${String(cause)}`); }
  }

  handle(req: Request): Promise<Response | null> {
    return /^\/v1\/meet(?:\/|$)/.test(new URL(req.url).pathname) ? this.proxy(req, null) : Promise.resolve(null);
  }
  handleAgent(req: Request, meetingId: string): Promise<Response> { return this.proxy(req, meetingId); }

  private async required<T>(path: string, body: unknown, timeoutMs = 5000): Promise<T> {
    const result = await runtimeCall<T>(this.socket, path, body, timeoutMs);
    // These methods retain the supervisor's existing await/reject contract for queued handoffs and external requests.
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }
  async flushTranscript(id: string): Promise<void> { await this.required("/runtime/flush", { id }, 25_000); }
  captureDelegation(id: string): Promise<{ images: ImageContent[]; note: string }> { return this.required("/runtime/capture", { id }); }
  openExternal(id: string, sessionId: string, apiUrl: string, platformTranscript = false): Promise<MeetJoined> {
    return this.required("/runtime/open-external", { id, sessionId, apiUrl, platformTranscript, context: this.context([sessionId], { meetingId: id, sessionId }) });
  }
  async stopExternal(id: string): Promise<void> { await this.required("/runtime/stop-external", { id }); }
}
