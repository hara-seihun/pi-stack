import { afterAll, expect, test } from "bun:test";
import type { MeetJoined, MeetPoll } from "../server/meet/protocol";
import { MeetRoom, post } from "./src/meet/room";
import { meetJson, type MeetRequest } from "./src/meet/transport";
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: {} });
const { VoiceSession } = await import("./src/voice");

class Track {
  enabled = true;
  readyState = "live";
  kind = "audio";
  stop() { this.readyState = "ended"; }
}
class Stream {
  id = "microphone";
  track = new Track();
  getTracks() { return [this.track]; }
  getAudioTracks() { return [this.track]; }
}
class Connection {
  connectionState = "connected";
  signalingState = "stable";
  remoteDescription = null;
  localDescription = { type: "offer", sdp: "v=0\r\no=test" };
  onnegotiationneeded!: () => Promise<void>;
  onicecandidate: unknown;
  senders: Array<{ track: Track }> = [];
  closed = false;
  getSenders() { return this.senders; }
  addTrack(track: Track) { this.senders.push({ track }); }
  removeTrack(sender: { track: Track }) { this.senders.splice(this.senders.indexOf(sender), 1); }
  async setLocalDescription() {}
  close() { this.closed = true; }
}
const rtc = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, writable: true, value: Connection });
afterAll(() => {
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
  if (rtc) Object.defineProperty(globalThis, "RTCPeerConnection", rtc);
  else Reflect.deleteProperty(globalThis, "RTCPeerConnection");
});
const joined: MeetJoined = {
  participant: { id: "host", name: "Host", host: true },
  room: { id: "room", sessionId: "thread", apiUrl: "/v1/meet/room", participants: [
    { id: "host", name: "Host", host: true }, { id: "guest", name: "Guest", host: false },
  ], iceServers: [], browser: null, threads: [], voiceMuted: false, voiceRevision: 3,
    voiceWake: null, platformTranscript: false, transcriptFlushRevision: 0 },
};
const poll = (seq = 7): MeetPoll => ({ ...joined.room, messages: [
  { seq, from: "guest", signal: { candidate: { candidate: `candidate-${seq}` } } },
] });
function session(request: MeetRequest, result = joined) {
  const microphone = new Stream();
  const voice = new VoiceSession({ sessionId: "thread", onState() {}, onNotice() {} });
  voice.state = "live";
  voice.microphone = microphone;
  voice.peer = new Connection();
  const failures: string[] = [];
  let closing: Promise<void> | null = null;
  const room = new MeetRoom(result, "", () => {}, () => {}, () => {}, (message) => {
    failures.push(message);
    closing = voice.stop();
  }, request);
  room.publish("camera", microphone as any);
  return { room, voice, microphone, failures, async close() { room.close(false); await (closing ?? voice.stop()); } };
}
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

for (const failure of ["503", "network"] as const) test(`${failure} after joined poll retains peers, microphone, Voice and cursor`, async () => {
  const paths: string[] = [];
  let polls = 0;
  const request: MeetRequest = async (path) => {
    if (path.endsWith("/join")) return Response.json(joined);
    paths.push(path);
    polls++;
    if (polls === 2) {
      if (failure === "network") throw new TypeError("Failed to fetch");
      return new Response("router restarting", { status: 503 });
    }
    return Response.json(polls === 1 ? poll() : { ...poll(8), voiceMuted: true, voiceRevision: 2,
      messages: [...poll().messages, ...poll(8).messages] });
  };
  const accepted = await meetJson<MeetJoined>(request, "/v1/meet/room/join", post({ name: "Host" }));
  const s = session(request, accepted);
  try {
    await s.room.poll();
    const peer = s.room.peers.get("guest")!;
    const voicePeer = s.voice.peer;
    const recovery = s.room.poll();
    await tick();
    expect(s.room.peers.get("guest")).toBe(peer);
    expect((peer.connection as any).closed).toBe(false);
    expect(s.microphone.track.readyState).toBe("live");
    expect(s.voice.state).toBe("live");
    expect(s.voice.peer).toBe(voicePeer);
    expect(s.failures).toEqual([]);
    await recovery;
    expect(paths).toEqual([
      "/v1/meet/room/poll?participant=host&after=0",
      "/v1/meet/room/poll?participant=host&after=7",
      "/v1/meet/room/poll?participant=host&after=7",
    ]);
    expect(s.room.peers.get("guest")).toBe(peer);
    expect(peer.candidates).toHaveLength(2); // The already-consumed seq 7 was not replayed.
    expect(s.room.snapshot.voiceRevision).toBe(3);
    expect(s.room.snapshot.voiceMuted).toBe(false);
    expect(s.microphone.track.readyState).toBe("live");
    expect(s.voice.state).toBe("live");
  } finally { await s.close(); }
});

test("lost signaling response retries the identical request ID and payload without replacing the peer", async () => {
  const bodies: string[] = [];
  const s = session(async (path, init) => {
    if (path.includes("/poll")) return Response.json(poll());
    bodies.push(String(init.body));
    if (bodies.length === 1) throw new TypeError("response lost after acceptance");
    return Response.json({ ok: true });
  });
  try {
    await s.room.poll();
    const peer = s.room.peers.get("guest")!;
    const signaling = (peer.connection as any).onnegotiationneeded();
    await tick();
    expect(s.voice.state).toBe("live");
    expect(s.failures).toEqual([]);
    await signaling;
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[0]!).requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.room.peers.get("guest")).toBe(peer);
  } finally { await s.close(); }
});

for (const terminal of ["404", "permission", "invalid JSON", "request parser", "invalid signal", "media protocol"] as const) test(`${terminal} remains terminal and closes media via its owner`, async () => {
  let calls = 0;
  const s = session(async () => {
    calls++;
    if (calls === 1) return Response.json(poll());
    if (terminal === "404") return Response.json({ error: "Meeting missing" }, { status: 404 });
    if (terminal === "permission") return Response.json({ error: "Not allowed" }, { status: 403 });
    if (terminal === "invalid JSON") return new Response("invalid json");
    if (terminal === "request parser") throw new SyntaxError("Relay returned an invalid payload");
    return Response.json({ ...poll(8), messages: [{ seq: 8, from: "guest", signal: { description: { type: "offer", sdp: "invalid" } } }] });
  });
  try {
    await s.room.poll();
    const peer = s.room.peers.get("guest")!;
    if (terminal === "media protocol") (peer.connection as any).ontrack({ streams: [] });
    else await s.room.poll();
    expect(s.failures).toHaveLength(1);
    expect(s.room.peers.size).toBe(0);
    expect((peer.connection as any).closed).toBe(true);
    expect(s.microphone.track.readyState).toBe("ended");
    await s.room.poll();
    expect(calls).toBe(terminal === "media protocol" ? 1 : 2);
  } finally { await s.close(); }
});

test("invalid signaling acknowledgements are terminal, not retried", async () => {
  let signals = 0;
  const s = session(async (path) => {
    if (path.includes("/poll")) return Response.json(poll());
    signals++;
    return Response.json({ ok: false });
  });
  try {
    await s.room.poll();
    await (s.room.peers.get("guest")!.connection as any).onnegotiationneeded();
    expect(signals).toBe(1);
    expect(s.failures).toEqual(["Meet returned an invalid signaling acknowledgement"]);
    expect(s.microphone.track.readyState).toBe("ended");
  } finally { await s.close(); }
});

test("explicit Stop cancels transport recovery and cannot resurrect media", async () => {
  let calls = 0;
  const s = session(async () => {
    calls++;
    return calls === 1 ? Response.json(poll()) : new Response("deploying", { status: 503 });
  });
  await s.room.poll();
  const peer = s.room.peers.get("guest")!;
  const recovering = s.room.poll();
  await tick();
  await s.close();
  await recovering;
  expect(s.failures).toEqual([]);
  expect((peer.connection as any).closed).toBe(true);
  expect(s.microphone.track.readyState).toBe("ended");
  expect(s.room.peers.size).toBe(0);
  await s.room.poll();
  expect(calls).toBe(2);
});

test("recovery has a 20-second deadline even if a transport ignores cancellation", async () => {
  const timers = new Map<number, { after: number; run(): void }>();
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let serial = 0, now = 0;
  globalThis.setTimeout = ((run: () => void, after: number) => {
    const id = ++serial; timers.set(id, { after: now + after, run }); return id;
  }) as any;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as any;
  let calls = 0;
  const s = session(async () => {
    calls++;
    return calls === 1 ? Response.json(poll()) : new Promise<Response>(() => {});
  });
  try {
    await s.room.poll();
    const peer = s.room.peers.get("guest")!;
    const result = s.room.poll();
    await tick();
    while (timers.size) {
      const [id, timer] = [...timers].sort((a, b) => a[1].after - b[1].after)[0]!;
      timers.delete(id); now = timer.after; timer.run();
      for (let i = 0; i < 10; i++) await tick();
    }
    await result;
    expect(s.failures).toHaveLength(1);
    expect(s.failures[0]).toContain("did not recover within 20 seconds");
    expect(s.room.peers.size).toBe(0);
    expect((peer.connection as any).closed).toBe(true);
    expect(s.microphone.track.readyState).toBe("ended");
    expect(now).toBe(20_000);
    expect(calls).toBe(5);
  } finally { await s.close(); globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});
