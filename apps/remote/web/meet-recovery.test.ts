import { afterAll, expect, mock, test } from "bun:test";

mock.module("./src/meet/pcm.worklet.js?raw", () => ({ default: "" }));
const replaced = new Map<string, PropertyDescriptor | undefined>();
function provide(name: string, value: unknown) {
  replaced.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
afterAll(() => {
  for (const [name, descriptor] of replaced) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

class Track {
  enabled = true;
  readyState = "live";
  constructor(readonly kind = "audio") {}
  stop() { this.readyState = "ended"; }
  clone() { return new Track(this.kind); }
  addEventListener() {}
}
class Stream {
  id = crypto.randomUUID();
  constructor(private tracks: Track[] = []) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
  addTrack(track: Track) { this.tracks.push(track); }
}
class AudioNode {
  connect() {}
  disconnect() {}
}
const contexts: FakeAudioContext[] = [];
class FakeAudioContext {
  state = "running";
  currentTime = 0;
  destination = new AudioNode();
  audioWorklet = { addModule: async () => {} };
  constructor() { contexts.push(this); }
  createMediaStreamSource() { return new AudioNode(); }
  createDynamicsCompressor() { return new AudioNode(); }
  createMediaStreamDestination() { return { stream: new Stream([new Track()]) }; }
  async resume() {}
  async close() { this.state = "closed"; }
}
const pcm = new Int16Array([901, -207, 0]).buffer;
class Worklet extends AudioNode {
  pending = true;
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (message: { flush: string }) => queueMicrotask(() => {
      if (this.pending) {
        this.pending = false;
        this.port.onmessage?.({ data: { audio: pcm, startedAt: 0 } });
      }
      this.port.onmessage?.({ data: { flushed: message.flush } });
    }),
  };
}
const drawing = new Proxy({
  createLinearGradient: () => ({ addColorStop() {} }),
  measureText: (text: string) => ({ width: text.length * 10 }),
}, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
function element() {
  return { style: {}, append() {}, remove() {}, pause() {}, setAttribute() {}, play: async () => {},
    getContext: () => drawing, captureStream: () => new Stream([new Track("video")]) };
}
provide("window", {});
provide("document", { createElement: element });
provide("Image", class { naturalWidth = 64; naturalHeight = 64; async decode() {} });
provide("MediaStream", Stream);
provide("AudioContext", FakeAudioContext);
provide("AudioWorkletNode", Worklet);
provide("__MEET_AVATAR__", "data:image/png;base64,AA==");

const { startMeetAdapter, MeetAdapterStartError } = await import("./src/meet/adapter");
const { meetThreadStatus } = await import("./src/meet/media");
const { VoiceSession } = await import("./src/voice");

const thread = (patch: Record<string, unknown> = {}) => ({
  id: "thread", name: "Thread", state: "idle", held: false, activity: "idle", tools: [], output: "", events: [], ...patch,
}) as any;

test("meeting thread labels follow the shared held, activity and multi-tool rules", () => {
  expect(meetThreadStatus(thread({ held: true }))).toMatchObject({ label: "Stopped" });
  expect(meetThreadStatus(thread({ state: "running", activity: "thinking" }))).toMatchObject({ label: "Thinking" });
  expect(meetThreadStatus(thread({ state: "running", activity: "compacting" }))).toMatchObject({ label: "Compacting context" });
  expect(meetThreadStatus(thread({ state: "running", activity: "waiting_on_tool", tools: ["bash", "web_search"] }))).toMatchObject({ label: "Running bash and web search" });
  expect(meetThreadStatus(thread({ state: "running", activity: "waiting_on_tool", tools: ["bash", "web_search", "agent_browser"] }))).toMatchObject({ label: "Running 3 tools", title: "bash, web search, agent browser" });
});

test("failed startup stops capture and retains its unfinished PCM until recovery closes", async () => {
  const input = new Stream([new Track()]);
  let captures = 0;
  provide("navigator", { mediaDevices: { getUserMedia: async () => { captures++; return input; } } });
  const participant = { id: "external-host", host: true, name: "Mixed meeting audio" };
  const room = { id: "room", sessionId: "thread", apiUrl: "", iceServers: [], participants: [participant],
    browser: null, threads: [], voiceMuted: true, voiceRevision: 0, transcriptFlushRevision: 0 };
  let connected = true;
  const uploads: Array<{ path: string; body: unknown; connected: boolean }> = [];
  let stops = 0;
  let opens = 0;
  const request = async (path: string, init: RequestInit) => {
    if (path.includes("/transcript/audio")) uploads.push({ path, body: init.body, connected });
    if (path === "/v1/voice") connected = false;
    if (!connected) throw new Error("relay disconnected");
    if (path === "/v1/meet/external") { opens++; return Response.json({ room, participant }); }
    if (path.includes("/poll")) return Response.json({ ...room, messages: [] });
    if (path.endsWith("/stop")) stops++;
    return Response.json({ saved: true });
  };
  let failure: InstanceType<typeof MeetAdapterStartError> | undefined;
  try { await startMeetAdapter({ request, namespace: "recall", eventKey: "event", container: element() as any }); }
  catch (error) { expect(error).toBeInstanceOf(MeetAdapterStartError); failure = error as typeof failure; }
  expect(failure).toBeDefined();
  expect(input.getTracks().every((track) => track.readyState === "ended")).toBe(true);
  expect(captures).toBe(1);
  expect(uploads.length).toBeGreaterThan(0);
  expect(uploads[0]!.connected).toBe(false);
  expect(contexts.some((context) => context.state !== "closed")).toBe(true);
  await expect(failure!.recovery.close()).rejects.toThrow("relay disconnected");
  connected = true;
  await failure!.recovery.close();
  expect(uploads.at(-1)!.connected).toBe(true);
  expect(uploads.at(-1)!.path).toBe(uploads[0]!.path);
  expect(uploads.at(-1)!.body).toBe(pcm);
  expect(opens).toBe(2);
  expect(stops).toBe(1);
  expect(captures).toBe(1);
  expect(contexts.every((context) => context.state === "closed")).toBe(true);
  expect(failure!.recovery.state.status).toBe("closed");
});

test("meeting handoffs retain Voice's triggering speech alongside the saved meeting transcript", async () => {
  const prompts: Array<{ text: string; includeMeetingImages: boolean; delivery: string }> = [];
  let flushed = false;
  const voice = new VoiceSession({
    sessionId: "thread",
    meetingContext: () => "Kenan's outgoing voice is muted.",
    handoffContext: async () => { flushed = true; },
    onState() {},
    onNotice(message) { throw new Error(message); },
    request: async (_path, init) => {
      expect(flushed).toBe(true);
      prompts.push(JSON.parse(String(init.body)));
      return Response.json({ workId: `work-${prompts.length}` });
    },
  });
  const speech = (id: string, text: string) => voice.handleLiveMessage(JSON.stringify({
    type: "session.input_transcript.delta", event_id: id, delta: text, start_ms: 0, end_ms: 1000,
  }));
  const delegate = async (id: string) => {
    voice.handleLiveMessage(JSON.stringify({
      type: "session.delegation.created", event_id: id, delegation: { id, target: "client" }, offset_ms: 1000,
    }));
    await voice.delegationQueue;
  };
  speech("speech-1", "Kenan, unmute yourself.");
  await delegate("delegation-1");
  expect(prompts[0]!.text).toContain("User: Kenan, unmute yourself.");
  expect(prompts[0]!.includeMeetingImages).toBe(true);
  expect(prompts[0]!.delivery).toBe("hardSteer");
  speech("speech-2", "Now show the browser.");
  await delegate("delegation-2");
  expect(prompts[1]!.text).toContain("User: Now show the browser.");
  expect(prompts[1]!.text).not.toContain("unmute yourself");
  expect(voice.delegationsSubmitted).toBe(2);
});

test("Voice stop silences local capture and playback before remote settlement", async () => {
  let finish!: () => void;
  const settlement = new Promise<void>((resolve) => { finish = resolve; });
  const voice = new VoiceSession({ sessionId: "thread", onState() {}, onNotice() {} });
  const microphone = new Stream([new Track()]);
  const speaker = { muted: false, paused: false, srcObject: microphone, pause() { this.paused = true; } };
  voice.microphone = microphone;
  voice.speaker = speaker;
  voice.reportUsage = () => settlement;
  const stopped = voice.stop();
  expect(microphone.getTracks()[0]!.readyState).toBe("ended");
  expect(speaker.paused).toBe(true);
  expect(speaker.muted).toBe(true);
  expect(speaker.srcObject).toBeNull();
  finish();
  await stopped;
});
