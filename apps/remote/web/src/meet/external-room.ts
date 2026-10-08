import { meetPath, type MeetJoined, type MeetSnapshot, type MeetVoiceControl } from "../../../server/meet/protocol";
import { parsePoll } from "./poll";
import { holdLiveMedia } from "../live-media";
import { meetJson, recoverMeetRequest, type MeetRequest } from "./transport";

export const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export class ExternalMeetRoom {
  snapshot: MeetSnapshot;
  private stopped = false;
  private polling = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly abort = new AbortController();
  readonly request: MeetRequest;
  private readonly releaseMedia: () => void;

  constructor(
    readonly joined: MeetJoined,
    readonly onSnapshot: (room: MeetSnapshot) => void,
    readonly onFailure: (message: string) => void,
    request: MeetRequest,
  ) {
    if (!joined?.room || !joined.participant) throw new Error("Meet returned an invalid external room");
    this.snapshot = parsePoll(joined.room, joined);
    this.request = (path, init = {}) => {
      const deadline = AbortSignal.timeout(20_000);
      return request(path, { ...init, signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline, cache: "no-store" });
    };
    this.releaseMedia = holdLiveMedia();
  }

  json<T>(path: string, init: RequestInit = {}): Promise<T> {
    return meetJson<T>(this.request, path, init);
  }

  applyVoiceControl(state: MeetVoiceControl) {
    if (state.revision < this.snapshot.voiceRevision) return;
    this.snapshot = { ...this.snapshot, voiceMuted: state.muted, voiceRevision: state.revision };
    this.onSnapshot(this.snapshot);
  }

  path(suffix: string, extra: Record<string, string> = {}) {
    const query = new URLSearchParams({ participant: this.joined.participant.id, ...extra });
    return `${meetPath(this.joined.room.id, suffix)}?${query}`;
  }

  private fail(cause: unknown) {
    if (this.stopped) return;
    this.close();
    this.onFailure(String(cause instanceof Error ? cause.message : cause));
  }

  async poll() {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const result = await recoverMeetRequest(this.request, this.path("/poll"), {}, this.abort.signal);
      if (this.stopped) return;
      if (!result.ok) { this.fail(result.error.message); return; }
      if (!result.value.ok) { this.fail(`Meet HTTP ${result.value.status}: ${result.value.text}`); return; }
      const snapshot = parsePoll(JSON.parse(result.value.text), this.joined);
      if (snapshot.voiceRevision < this.snapshot.voiceRevision) {
        snapshot.voiceMuted = this.snapshot.voiceMuted;
        snapshot.voiceRevision = this.snapshot.voiceRevision;
      }
      this.snapshot = snapshot;
      this.onSnapshot(snapshot);
      if (!this.stopped) this.timer = setTimeout(() => void this.poll(), 750);
    } catch (cause) { this.fail(cause); }
    finally { this.polling = false; }
  }

  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    this.releaseMedia();
  }
}
