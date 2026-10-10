import { after, before, test, type TestContext } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RetellClient as SDKClient } from "retell-client-js-sdk";

let RetellClient: typeof SDKClient;
const output = mkdtempSync(join(tmpdir(), "retell-lifecycle-"));
before(async () => {
  const require = createRequire(import.meta.url);
  const vite = join(dirname(require.resolve("vite/package.json")), "bin/vite.js");
  // Use the production alias and source repair, not a test copy of SDK lifecycle logic.
  execFileSync(process.execPath.includes("bun") ? "node" : process.execPath, [
    vite, "build", "--config", "vite.phone-media.config.ts", "--outDir", output, "--logLevel", "error",
  ], { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 30_000, stdio: "pipe" });
  ({ RetellClient } = await import(pathToFileURL(join(output, "retell-sdk.js")).href));
});
after(() => rmSync(output, { recursive: true, force: true }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class DataChannel {
  onmessage: ((event: { data: string }) => void) | null = null;
  closes = 0;
  receive(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
  close() { this.closes++; }
}

class PeerConnection {
  readonly channel = new DataChannel();
  readonly transceiver = {
    direction: "recvonly",
    sender: { replaceTrack: async (_track: unknown) => {} },
  };
  localDescription: { type: string; sdp: string } | null = null;
  connectionState = "new";
  iceConnectionState = "new";
  signalingState = "stable";
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  closes = 0;
  addTransceiver() { return this.transceiver; }
  getTransceivers() { return [this.transceiver]; }
  createDataChannel() { return this.channel; }
  async createOffer() { return { type: "offer", sdp: "synthetic offer" }; }
  async setLocalDescription(description: { type: string; sdp: string }) {
    this.localDescription = description;
    this.signalingState = "have-local-offer";
  }
  async setRemoteDescription() { this.connectionState = "connected"; this.signalingState = "stable"; }
  fail(path: "connection" | "ice") {
    if (path === "connection") { this.connectionState = "failed"; this.onconnectionstatechange?.(); }
    else { this.iceConnectionState = "failed"; this.oniceconnectionstatechange?.(); }
  }
  close() {
    this.closes++;
    this.connectionState = this.iceConnectionState = this.signalingState = "closed";
    this.onconnectionstatechange?.();
    this.oniceconnectionstatechange?.();
  }
}

class MonitorWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closes = 0;
  receive(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
  close() { this.closes++; this.onclose?.({ code: 1000, reason: "" }); }
}

type Phase = "listening" | "requesting" | "taken_over";
async function fixture(t: TestContext, phase: Phase) {
  const peers: PeerConnection[] = [], sockets: MonitorWebSocket[] = [];
  const requests: { path: string; method: string }[] = [];
  const tracks: { stop: () => void; stops: number }[] = [];
  const requested = deferred<void>(), response = deferred<Response>();
  let takingOver: Promise<void> | undefined;
  let deletes = 0;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install("RTCPeerConnection", class extends PeerConnection {
    constructor() { super(); peers.push(this); }
  });
  install("WebSocket", class extends MonitorWebSocket {
    constructor() { super(); sockets.push(this); }
  });
  install("navigator", { mediaDevices: { getUserMedia: async () => {
    const track = { stops: 0, stop() { this.stops++; } };
    tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  } } });
  install("fetch", async (input: string, options: RequestInit) => {
    const path = new URL(input).pathname, method = options.method!;
    requests.push({ path, method });
    if (path === "/v2/listen-live-call/call_test" && method === "POST") {
      return Response.json({ access_token: "synthetic-token", participant_id: "owner", transport: "gateway" });
    }
    if (path === "/v2/take-over-live-call/call_test" && method === "POST") {
      assert.deepEqual(JSON.parse(String(options.body)), { participant_id: "owner" });
      requested.resolve();
      return response.promise;
    }
    if (path === "/webrtc-proxy/call_test/v1/webrtc/sessions" && method === "POST") {
      return Response.json({ session_id: "session_test", sdp: "synthetic answer" });
    }
    if (path === "/webrtc-proxy/call_test/v1/webrtc/sessions/session_test") {
      if (method === "PATCH") return new Response("synthetic answer");
      if (method === "DELETE") { deletes++; return new Response(null, { status: 204 }); }
    }
    throw new Error(`Unexpected SDK request: ${method} ${path}`);
  });

  const ends: unknown[] = [], statuses: string[] = [];
  const session = new RetellClient({ key: "synthetic-key", baseURL: "https://retell.invalid" }).monitorCall({
    call_id: "call_test",
    hooks: { onEnd: event => ends.push(event), onStatus: status => statuses.push(status) },
  });
  t.after(async () => {
    response.resolve(new Response(null, { status: 204 }));
    await takingOver?.catch(() => {});
    session.disconnect();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  await Promise.resolve();
  assert.equal(sockets.length, 1);
  sockets[0].receive({ type: "transcript_snapshot", transcripts: [], pre_session_transcripts: [] });
  await session.ready;
  await session.listen();
  assert.equal(peers.length, 1);
  const peer = peers[0], socket = sockets[0];
  assert.equal(session.status, "listening");
  if (phase !== "listening") {
    takingOver = session.takeOver();
    takingOver.catch(() => {});
    await requested.promise;
    if (phase === "taken_over") {
      response.resolve(new Response(null, { status: 204 }));
      await takingOver;
      assert.equal(session.status, "taken_over");
    }
  }
  return {
    session, peer, socket, ends, statuses, requests, tracks,
    resolveTakeover: async (ok: boolean) => {
      response.resolve(new Response(null, { status: ok ? 204 : 409 }));
      if (ok) await takingOver;
      else await assert.rejects(takingOver!);
    },
    assertOpen() {
      assert.notEqual(session.status, "ended");
      assert.equal(peer.closes, 0);
      assert.equal(peer.channel.closes, 0);
      assert.equal(deletes, 0);
      assert.deepEqual(ends, []);
    },
    assertClosed() {
      assert.equal(session.status, "ended");
      assert.equal(peer.closes, 1);
      assert.equal(peer.channel.closes, 1);
      assert.equal(socket.closes, 1);
      assert.equal(deletes, 1);
      assert.equal(ends.length, 1);
      assert.equal(statuses.filter(status => status === "ended").length, 1);
    },
  };
}

for (const phase of ["requesting", "taken_over"] as const) {
  for (const state of ["replaced", "ended"] as const) {
    test(`gateway AI-leg ${state} during ${phase} preserves owner's media`, async t => {
      const f = await fixture(t, phase);
      f.peer.channel.receive({ type: "status", state });
      f.assertOpen();
      assert.equal(f.socket.closes, 1);
      if (phase === "requesting") await f.resolveTakeover(true);
      assert.equal(f.session.status, "taken_over");
      f.assertOpen();
      f.session.disconnect();
      f.assertClosed();
    });
  }
}

for (const state of ["replaced", "ended"] as const) {
  test(`gateway ${state} before owner's takeover closes listener`, async t => {
    const f = await fixture(t, "listening");
    f.peer.channel.receive({ type: "status", state });
    f.assertClosed();
    await assert.rejects(f.session.takeOver(), /Session has ended/);
    assert.ok(!f.requests.some(request => request.path.includes("take-over-live-call")));
  });
}

for (const phase of ["requesting", "taken_over"] as const) {
  for (const path of ["gateway", "monitor"] as const) {
    test(`named user_hangup over ${path} during ${phase} closes owner's media`, async t => {
      const f = await fixture(t, phase);
      if (path === "gateway") f.peer.channel.receive({ type: "status", state: "ended", disconnection_reason: "user_hangup" });
      else f.socket.receive({ type: "call_ended", disconnection_reason: "user_hangup" });
      f.assertClosed();
      assert.deepEqual(f.ends, [path === "gateway"
        ? { type: "status", state: "ended", disconnection_reason: "user_hangup" }
        : { disconnection_reason: "user_hangup" }]);
      if (phase === "requesting") await assert.rejects(f.resolveTakeover(true), /Call ended before take-over/);
    });
  }
}

for (const path of ["connection", "ice"] as const) {
  test(`genuine ${path} transport failure after AI-leg replacement closes owner's media`, async t => {
    const f = await fixture(t, "taken_over");
    f.peer.channel.receive({ type: "status", state: "replaced" });
    f.assertOpen();
    f.peer.fail(path);
    f.assertClosed();
  });
}

for (const phase of ["requesting", "taken_over"] as const) {
  test(`owner disconnect during ${phase} closes transport exactly once`, async t => {
    const f = await fixture(t, phase);
    f.session.disconnect();
    f.assertClosed();
    f.session.disconnect();
    f.peer.fail("connection");
    f.assertClosed();
    if (phase === "requesting") await assert.rejects(f.resolveTakeover(true), /Call ended before take-over/);
  });
}

test("rejected takeover makes the deferred AI-leg end terminal", async t => {
  const f = await fixture(t, "requesting");
  f.peer.channel.receive({ type: "status", state: "replaced" });
  f.assertOpen();
  await f.resolveTakeover(false);
  f.assertClosed();
  assert.ok(f.tracks.every(track => track.stops === 1));
});
