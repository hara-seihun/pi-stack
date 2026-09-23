import { piFetch } from "../client";
import { meetPath, type MeetJoined, type MeetParticipant, type MeetPoll, type MeetSignal, type MeetSnapshot, type MeetTrackKind, type MeetVoiceControl } from "../../../server/meet/protocol";
import type { MeetMediaSource } from "./media";
import { meetJson, type MeetRequest } from "./transport";

type Peer = {
  connection: RTCPeerConnection; participant: MeetParticipant; streams: Record<string, MeetTrackKind>;
  makingOffer: boolean; ignoredOffer: boolean; candidates: RTCIceCandidateInit[];
  queue: Promise<void>;
};

function browserRequest(owner: string): MeetRequest {
  return async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (owner) headers.set("x-pi-remote-user", owner);
    const response = owner && owner !== window.PiRemotePerson.get()
      ? await fetch(path, { ...init, headers }) : await piFetch(path, { ...init, headers });
    if (response.status === 423) throw new Error("The meeting host must unlock Pi Remote before guests can join");
    return response;
  };
}

function boundedRequest(request: MeetRequest): MeetRequest {
  return (path, init = {}) => {
    const deadline = AbortSignal.timeout(20_000);
    return request(path, { ...init, signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline, cache: "no-store" });
  };
}

export function meetRequest<T>(path: string, owner: string, init: RequestInit = {}): Promise<T> {
  return meetJson<T>(boundedRequest(browserRequest(owner)), path, init);
}
export const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export class MeetRoom {
  readonly peers = new Map<string, Peer>();
  readonly published = new Map<MeetTrackKind, MediaStream>();
  snapshot: MeetSnapshot;
  private cursor = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly abort = new AbortController();
  readonly request: MeetRequest;

  constructor(
    readonly joined: MeetJoined,
    readonly owner: string,
    readonly onSnapshot: (room: MeetSnapshot) => void,
    readonly onMedia: (source: MeetMediaSource) => void,
    readonly onLeave: (id: string) => void,
    readonly onFailure: (message: string) => void,
    request: MeetRequest = browserRequest(owner),
  ) { this.snapshot = joined.room; this.request = boundedRequest(request); }

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

  publish(kind: MeetTrackKind, stream: MediaStream) {
    this.published.set(kind, stream);
    for (const peer of this.peers.values()) this.reconcileTracks(peer);
  }

  unpublish(kind: MeetTrackKind) {
    const stream = this.published.get(kind);
    this.published.delete(kind);
    for (const peer of this.peers.values()) this.reconcileTracks(peer);
    stream?.getTracks().forEach((track) => track.stop());
  }

  private reconcileTracks(peer: Peer) {
    const tracks = [...this.published.values()].flatMap((stream) => stream.getTracks());
    for (const sender of peer.connection.getSenders()) if (sender.track && !tracks.includes(sender.track)) peer.connection.removeTrack(sender);
    for (const stream of this.published.values()) for (const track of stream.getTracks()) {
      if (!peer.connection.getSenders().some((sender) => sender.track === track)) peer.connection.addTrack(track, stream);
    }
  }

  private async signal(id: string, signal: MeetSignal) {
    if (this.stopped) return;
    const response = await this.request(this.path("/signal"), {
      ...post({ to: id, signal }),
      signal: this.abort.signal,
    });
    if (response.status === 410) return;
    if (!response.ok) throw new Error((await response.json()).error || "Meet signaling failed");
  }

  private fail(cause: unknown) {
    if (this.stopped) return;
    this.onFailure(String(cause instanceof Error ? cause.message : cause));
    this.close(false);
  }

  private peer(participant: MeetParticipant) {
    const existing = this.peers.get(participant.id);
    if (existing) return existing;
    const connection = new RTCPeerConnection({ iceServers: this.snapshot.iceServers });
    const peer: Peer = { connection, participant, streams: {}, makingOffer: false, ignoredOffer: false, candidates: [], queue: Promise.resolve() };
    this.peers.set(participant.id, peer);
    const failed = (cause: unknown) => { if (this.peers.get(participant.id) === peer) this.fail(cause); };
    connection.onicecandidate = (event) => {
      if (event.candidate) void this.signal(participant.id, { candidate: { ...event.candidate.toJSON(), candidate: event.candidate.candidate } }).catch(failed);
    };
    connection.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await connection.setLocalDescription();
        await this.signal(participant.id, {
          description: { type: connection.localDescription!.type as "offer" | "answer", sdp: connection.localDescription!.sdp },
          streams: Object.fromEntries([...this.published].map(([kind, stream]) => [stream.id, kind])),
        });
      } catch (cause) { failed(cause); }
      finally { peer.makingOffer = false; }
    };
    connection.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream) { this.fail("A meeting adapter sent an unlabelled media track"); return; }
      const kind = peer.streams[stream.id];
      if (!kind) { this.fail("A meeting adapter omitted its stream identity"); return; }
      this.onMedia({ participant, kind, stream });
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed") this.fail(`Media connection to ${participant.name} failed. Check Tailscale and the host's Meet TURN relay.`);
    };
    this.reconcileTracks(peer);
    return peer;
  }

  private async receive(peer: Peer, signal: MeetSignal) {
    const connection = peer.connection;
    if (signal.streams) peer.streams = signal.streams;
    if (signal.description) {
      const collision = signal.description.type === "offer" && (peer.makingOffer || connection.signalingState !== "stable");
      peer.ignoredOffer = collision && this.joined.participant.id < peer.participant.id;
      if (peer.ignoredOffer) return;
      await connection.setRemoteDescription(signal.description);
      for (const candidate of peer.candidates.splice(0)) await connection.addIceCandidate(candidate);
      if (signal.description.type === "offer") {
        await connection.setLocalDescription();
        await this.signal(peer.participant.id, {
          description: { type: "answer", sdp: connection.localDescription!.sdp },
          streams: Object.fromEntries([...this.published].map(([kind, stream]) => [stream.id, kind])),
        });
      }
    } else if (signal.candidate && !peer.ignoredOffer) {
      if (connection.remoteDescription) await connection.addIceCandidate(signal.candidate);
      else peer.candidates.push(signal.candidate);
    }
  }

  async poll() {
    if (this.stopped) return;
    try {
      const snapshot = await this.json<MeetPoll>(this.path("/poll", { after: String(this.cursor) }), { signal: this.abort.signal });
      if (this.stopped) return;
      if (snapshot.voiceRevision < this.snapshot.voiceRevision) {
        snapshot.voiceMuted = this.snapshot.voiceMuted;
        snapshot.voiceRevision = this.snapshot.voiceRevision;
      }
      this.snapshot = snapshot;
      this.onSnapshot(snapshot);
      for (const [id, peer] of this.peers) if (!snapshot.participants.some((participant) => participant.id === id)) {
        peer.connection.close(); this.peers.delete(id); this.onLeave(id);
      }
      for (const participant of snapshot.participants) if (participant.id !== this.joined.participant.id) this.peer(participant);
      for (const message of snapshot.messages) {
        const peer = this.peers.get(message.from);
        if (peer) {
          peer.queue = peer.queue.then(() => this.receive(peer, message.signal));
          await peer.queue;
        }
        this.cursor = Math.max(this.cursor, message.seq);
      }
      if (!this.stopped) this.timer = setTimeout(() => void this.poll(), 750);
    } catch (cause) { this.fail(cause); }
  }

  close(leave = true) {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    const peers = [...this.peers.values()];
    this.peers.clear();
    for (const peer of peers) peer.connection.close();
    if (leave) void this.json(this.path("/leave"), { method: "POST", keepalive: true }).catch((cause) => {
      console.warn("Meet leave request failed; the server's participant lease owns cleanup within 45 seconds", cause);
    });
  }
}
