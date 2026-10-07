import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash, createHmac, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const adminToken = "synthetic-signalwire-owner-token".padEnd(48, "a");
const project = "synthetic-project-id";
const signingKey = "synthetic-signing-key";
const vonageSigningKey = "synthetic-vonage-signature-secret";
const vonageKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const callSid = "76ac3c36-56da-4a3e-a0d6-b5f8df6da9ad";
const streamSid = "7d56cc11-536d-4a45-b4fb-ed3d55be843b";
const callbackBase = "https://phone.example";
const brief = { to: "+442079460123", purpose: "Offline integration test only.",
  shareableFacts: ["This is a synthetic test."], opening: "Synthetic test opening.", maxSeconds: 60 };

async function eventually<T>(read: () => T | undefined | Promise<T | undefined>, description: string): Promise<T> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out: ${description}`);
}
function unusedPort() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
  const port = server.port; server.stop(true); return port;
}
// Independent callback signer: these tests do not import the implementation's signer.
function signature(path: string, params: URLSearchParams) {
  const data = callbackBase + path + [...params.keys()].sort().map(key => key + params.get(key)).join("");
  return createHmac("sha1", signingKey).update(data).digest("base64");
}
type ProviderRequest = { method: string; path: string; params: string; authorization: string };

async function fixture(mode: "accepted" | "uncertain" = "accepted", initialProvider: "signalwire" | "vonage" = "signalwire") {
  const root = mkdtempSync(join(tmpdir(), "pi-signalwire-service-test-"));
  const localPort = unusedPort(), publicPort = unusedPort();
  const base = `http://127.0.0.1:${localPort}`, publicBase = `http://127.0.0.1:${publicPort}`;
  const voiceRequests: { method: string; path: string; body: any }[] = [];
  const providerRequests: ProviderRequest[] = [];
  const browserPackets: ({ type: "pcm"; bytes: string } | { type: "control"; message: any })[] = [];
  const controls = new Set<Bun.ServerWebSocket<unknown>>();
  const sockets: WebSocket[] = [];
  let voiceCount = 0;
  const fake = Bun.serve({ hostname: "127.0.0.1", port: 0,
    websocket: { open(socket) { controls.add(socket); }, message() {}, close(socket) { controls.delete(socket); } },
    async fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path === "/control" && server.upgrade(req)) return;
      if (path === "/provider") {
        const request = await req.json() as ProviderRequest;
        providerRequests.push(request);
        if (request.path === "/v1/calls" && request.method === "POST") return Response.json({ uuid: callSid, status: "started" });
        if (request.path === `/v1/calls/${callSid}` && request.method === "PUT") return new Response(null, { status: 204 });
        if (request.path.endsWith("/Calls.json")) return mode === "uncertain"
          ? Response.json({ error: "Synthetic uncertain dial" }, { status: 500 })
          : Response.json({ sid: callSid, status: "queued" });
        return Response.json({ sid: callSid, status: "completed" });
      }
      if (path === "/browser-packet") { browserPackets.push(await req.json()); return Response.json({ ok: true }); }
      const body = req.method === "GET" ? null : await req.json();
      voiceRequests.push({ method: req.method, path, body });
      if (req.method === "POST" && path === "/sessions") return Response.json({ session: { id: `synthetic-voice-${++voiceCount}` }, sdp: "synthetic-answer" });
      return Response.json({ ok: true });
    },
  });
  writeFileSync(join(root, "admin-token"), adminToken, { mode: 0o600 });
  writeFileSync(join(root, "signalwire.json"), JSON.stringify({
    SIGNALWIRE_SPACE_URL: "https://synthetic-test.signalwire.com", SIGNALWIRE_PROJECT_ID: project,
    SIGNALWIRE_API_TOKEN: "synthetic-api-token", SIGNALWIRE_SIGNING_KEY: signingKey, SIGNALWIRE_FROM_NUMBER: "+15555550100",
  }), { mode: 0o600 });
  writeFileSync(join(root, "vonage.json"), JSON.stringify({ VONAGE_APPLICATION_ID: "synthetic-vonage-app",
    VONAGE_PRIVATE_KEY: vonageKeyPair.privateKey.export({ type: "pkcs8", format: "pem" }), VONAGE_SIGNATURE_SECRET: vonageSigningKey, VONAGE_FROM_NUMBER: "+15555550200" }), { mode: 0o600 });
  function configure(pstnProvider: "signalwire" | "vonage" | null) {
    writeFileSync(join(root, "config.json"), JSON.stringify({
      owner: "synthetic-test-owner", adminTokenFile: join(root, "admin-token"), localPort, publicPort,
      pstnProvider, callingEnabled: true, publicBaseUrl: callbackBase,
      signalwireCredentialFile: join(root, "signalwire.json"), vonageCredentialFile: join(root, "vonage.json"),
      voiceUrl: `http://127.0.0.1:${fake.port}`, chromium: join(root, "never-launch-a-real-browser"),
    }));
  }
  configure(initialProvider);
  // Chromium and provider HTTP are replaced; SQLite, owner auth, signed callbacks,
  // WebSockets, session state, audio conversion and cleanup run as deployed.
  writeFileSync(join(root, "runner.ts"), `
import { mock } from 'bun:test';
const nativeFetch = globalThis.fetch;
const testBase = process.env.TEST_FAKE_BASE;
globalThis.fetch = ((input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'synthetic-test.signalwire.com' || url.hostname === 'api.nexmo.com') return nativeFetch(testBase + '/provider', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      method: options.method, path: url.pathname, params: options.body?.toString() ?? '', authorization: options.headers.authorization,
    }),
  });
  if (url.hostname !== '127.0.0.1') throw new Error('External fetch forbidden in integration test');
  return nativeFetch(input, options);
});
const pages = [];
mock.module(${JSON.stringify(Bun.resolveSync("playwright-core", new URL(".", import.meta.url).pathname))}, () => ({ chromium: { async launch() {
  return { on() {}, async newPage() {
    let socket, control;
    const page = { async goto(value) {
      const url = new URL(value), token = url.hash.slice(1);
      socket = new WebSocket(url.origin.replace('http:', 'ws:') + '/browser-media');
      socket.binaryType = 'arraybuffer';
      socket.addEventListener('message', event => {
        const packet = typeof event.data === 'string' ? { type: 'control', message: JSON.parse(event.data) }
          : { type: 'pcm', bytes: Buffer.from(event.data).toString('base64') };
        void fetch(testBase + '/browser-packet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(packet) });
      });
      await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
      socket.send(JSON.stringify({ type: 'authenticate', token }));
      const response = await fetch(url.origin + '/media/offer', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ sdp: 'synthetic-offer' }) });
      if (!response.ok) throw new Error('Synthetic media offer rejected');
      control = new WebSocket(testBase.replace('http:', 'ws:') + '/control');
      control.addEventListener('message', event => { const command = JSON.parse(event.data); if (command.type === 'pcm') socket.send(Buffer.from(command.bytes, 'base64')); });
      await new Promise((resolve, reject) => { control.addEventListener('open', resolve, { once: true }); control.addEventListener('error', reject, { once: true }); });
      socket.send(JSON.stringify({ type: 'ready' }));
    }, async close() { socket?.close(); control?.close(); } };
    pages.push(page); return page;
  }, async close() { await Promise.all(pages.map(page => page.close())); } };
} } }));
await import(${JSON.stringify(new URL("./service.ts", import.meta.url).href)});
`);
  const launchChild = () => Bun.spawn([process.execPath, join(root, "runner.ts")], {
    env: { ...process.env, PI_STACK_PHONE_CONFIG: join(root, "config.json"), PI_STACK_PHONE_STATE: join(root, "state"), TEST_FAKE_BASE: `http://127.0.0.1:${fake.port}` },
    stdout: "ignore", stderr: "pipe",
  });
  let child: ReturnType<typeof launchChild>;
  let stderr: Promise<string>;
  function spawn() {
    child = launchChild();
    stderr = new Response(child.stderr).text();
  }
  const request = (path: string, method = "GET", body?: unknown) => fetch(base + path, {
    method, headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(1000),
  });
  async function ready() {
    await eventually(async () => {
      try { if ((await request("/status")).ok) return true; } catch {}
      if (child.exitCode !== null) throw new Error(`Service exited: ${await stderr}`);
    }, "phone service ready");
  }
  async function stop(signal: "SIGTERM" | "SIGKILL") {
    if (child.exitCode !== null) return;
    child.kill(signal);
    const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
    await child.exited; clearTimeout(timer);
  }
  async function close() {
    for (const socket of sockets) socket.close();
    await stop("SIGTERM"); fake.stop(true); rmSync(root, { recursive: true, force: true });
  }
  spawn();
  try { await ready(); } catch (e) { await close(); throw e; }
  async function state(id: string) { return (await (await request(`/calls/${id}`)).json()).call; }
  async function startCall() {
    const response = await request("/calls", "POST", brief); assert.equal(response.status, 202);
    return await response.json() as { id: string };
  }
  async function dialed() {
    return eventually(() => providerRequests.find(request => request.method === "POST" && (request.path.endsWith("/Calls.json") || request.path === "/v1/calls")), "synthetic provider dial");
  }
  async function callback(path: string, fields: Record<string, string>, signed = true) {
    const params = new URLSearchParams(fields);
    return fetch(publicBase + path, { method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded", ...(signed ? { "x-signalwire-signature": signature(path, params) } : {}),
    }, body: params, signal: AbortSignal.timeout(1000) });
  }
  async function vonageCallback(path: string, fields: Record<string, string>, signedBody: string | null = JSON.stringify(fields)) {
    const body = JSON.stringify(fields);
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000),
      payload_hash: createHash("sha256").update(signedBody ?? body).digest("hex") })).toString("base64url");
    const signature = createHmac("sha256", vonageSigningKey).update(`${header}.${payload}`).digest("base64url");
    return fetch(publicBase + path, { method: "POST", headers: { "content-type": "application/json",
      ...(signedBody === null ? {} : { authorization: `Bearer ${header}.${payload}.${signature}` }),
    }, body, signal: AbortSignal.timeout(1000) });
  }
  async function connectProvider(token: string, kind: "signalwire" | "vonage" = "signalwire") {
    const Client = WebSocket as typeof WebSocket & { new(url: string, options: Bun.WebSocketOptions): WebSocket };
    const socket = new Client(`${publicBase.replace("http:", "ws:")}/${kind}/media`, { headers: { authorization: `Bearer ${token}` } });
    socket.binaryType = "arraybuffer";
    const messages: any[] = [];
    sockets.push(socket);
    socket.addEventListener("message", event => messages.push(typeof event.data === "string" ? JSON.parse(event.data) : Buffer.from(event.data)));
    await Promise.race([
      new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("Provider upgrade rejected")), { once: true }); }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Provider upgrade timed out")), 2000); timer.unref(); }),
    ]);
    return { socket, messages };
  }
  async function restart(selection: "signalwire" | "vonage" | null) {
    await stop("SIGKILL"); configure(selection); spawn(); await ready();
  }
  function output(pcm: Buffer) {
    assert.equal(controls.size, 1);
    for (const socket of controls) socket.send(JSON.stringify({ type: "pcm", bytes: pcm.toString("base64") }));
  }
  const hangups = () => providerRequests.filter(r => r.method === "POST" && r.path.endsWith(`/Calls/${callSid}.json`) && new URLSearchParams(r.params).get("Status") === "completed");
  return { request, publicBase, startCall, state, dialed, callback, vonageCallback, connectProvider, restart, output, close, hangups, providerRequests, voiceRequests, browserPackets };
}
function bearer(request: ProviderRequest) {
  const params = new URLSearchParams(request.params);
  const laml = params.get("Laml")!;
  const match = /authBearerToken="([^"]+)"/.exec(laml); assert.ok(match);
  assert.match(laml, /codec="PCMU@8000h"/); assert.match(laml, /wss:\/\/phone\.example\/signalwire\/media/);
  return match[1];
}
function streamStart(socket: WebSocket, sid = callSid) {
  socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "0.2.0" }));
  socket.send(JSON.stringify({ event: "start", sequenceNumber: "1", start: {
    streamSid, callSid: sid, accountSid: project, tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
  } }));
}

test("SignalWire public callbacks require signatures/account and media upgrades require the isolated call bearer", async () => {
  const f = await fixture();
  try {
    for (const path of ["/signalwire/answer", "/signalwire/events/missing-call"]) {
      assert.equal((await f.callback(path, { AccountSid: project, CallSid: callSid }, false)).status, 403);
      assert.equal((await f.callback(path, { AccountSid: "wrong-project", CallSid: callSid })).status, 403);
      assert.equal((await f.callback(path, { CallSid: callSid })).status, 403);
    }
    for (const token of [null, "wrong", adminToken]) {
      assert.equal((await fetch(f.publicBase + "/signalwire/media", { headers: {
        connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "c3ludGhldGljdGVzdGtleQ==",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      } })).status, 403);
    }
    assert.deepEqual(await (await f.request("/calls")).json(), []);
    assert.equal(f.voiceRequests.length, 0); assert.equal(f.providerRequests.length, 0);
  } finally { await f.close(); }
}, 10_000);

test("actual service dials SignalWire once, bridges PCMU/PCM both ways and cleans PSTN plus Voice", async () => {
  const f = await fixture();
  try {
    const call = await f.startCall(), dial = await f.dialed();
    const params = new URLSearchParams(dial.params);
    assert.equal(params.get("To"), brief.to); assert.equal(params.get("From"), "+15555550100");
    assert.equal(params.get("StatusCallback"), `${callbackBase}/signalwire/events/${call.id}`);
    assert.equal(params.get("Timeout"), "30");
    assert.equal(dial.authorization, `Basic ${Buffer.from(project + ":synthetic-api-token").toString("base64")}`);
    await eventually(async () => (await f.state(call.id)).dial_state === "accepted" ? true : undefined, "accepted call ID");
    const provider = await f.connectProvider(bearer(dial)); streamStart(provider.socket);
    await eventually(async () => (await f.state(call.id)).status === "connected" ? true : undefined, "validated stream start");
    provider.socket.send(JSON.stringify({ event: "media", sequenceNumber: "2", media: { track: "inbound", chunk: "1", timestamp: "0", payload: Buffer.alloc(160, 255).toString("base64") } }));
    const packet = await eventually(() => f.browserPackets.find(p => p.type === "pcm"), "browser PCM input");
    assert.equal(packet.type, "pcm");
    if (packet.type !== "pcm") assert.fail();
    assert.deepEqual(Buffer.from(packet.bytes, "base64"), Buffer.alloc(640));
    f.output(Buffer.alloc(640));
    const outgoing = await eventually(() => provider.messages.find(message => message.event === "media"), "provider PCMU output");
    assert.deepEqual(outgoing, { event: "media", streamSid, media: { payload: Buffer.alloc(160, 255).toString("base64") } });
    assert.ok(f.browserPackets.some(p => p.type === "control" && p.message.type === "context"));
    assert.equal((await f.callback(`/signalwire/events/${call.id}`, { AccountSid: project, CallSid: callSid, CallStatus: "completed" })).status, 200);
    await eventually(async () => (await f.state(call.id)).cleanup === 1 ? true : undefined, "call cleanup");
    assert.equal((await f.state(call.id)).status, "completed");
    assert.equal(f.hangups().length, 1);
    assert.equal(f.voiceRequests.filter(req => req.method === "DELETE" && req.path === "/sessions/synthetic-voice-1").length, 1);
    assert.equal(f.providerRequests.filter(req => req.path.endsWith("/Calls.json")).length, 1);
    assert.equal((await (await f.request("/status")).json()).activeCalls, 0);
  } finally { await f.close(); }
}, 10_000);

test("Stream start cannot substitute another CallSid and malformed media terminates the owned call", async () => {
  for (const mismatch of [true, false]) {
    const f = await fixture();
    try {
      const call = await f.startCall(), dial = await f.dialed();
      await eventually(async () => (await f.state(call.id)).dial_state === "accepted" ? true : undefined, "accepted call");
      const provider = await f.connectProvider(bearer(dial)); streamStart(provider.socket, mismatch ? "another-call" : callSid);
      if (!mismatch) {
        await eventually(async () => (await f.state(call.id)).status === "connected" ? true : undefined, "valid stream start");
        provider.socket.send('{"event":"media","sequenceNumber":"2","media":{"track":"inbound","chunk":"1","timestamp":"0","payload":"not-base64!"}}');
      }
      await eventually(async () => (await f.state(call.id)).cleanup === 1 ? true : undefined, "invalid stream cleanup");
      assert.equal((await f.state(call.id)).status, "failed");
      assert.match((await f.state(call.id)).error, mismatch ? /identity-mismatch/ : /invalid-media/);
      assert.equal(f.hangups().length, 1);
      assert.equal(f.voiceRequests.filter(req => req.method === "DELETE").length, 1);
      assert.equal(f.browserPackets.filter(packet => packet.type === "pcm").length, 0);
    } finally { await f.close(); }
  }
}, 10_000);

test("restart cleans accepted SignalWire calls by stored provider kind even after Vonage or SIM-only selection", async () => {
  for (const selection of ["vonage", null] as const) {
    const f = await fixture();
    try {
      const call = await f.startCall(); await f.dialed();
      await eventually(async () => (await f.state(call.id)).dial_state === "accepted" ? true : undefined, "accepted call before crash");
      assert.equal((await f.state(call.id)).ended_at, null);
      await f.restart(selection);
      const stored = await f.state(call.id);
      assert.equal(stored.status, "interrupted"); assert.equal(stored.provider_kind, "signalwire");
      assert.equal(stored.provider_id, callSid); assert.equal(stored.cleanup, 1);
      assert.equal(f.hangups().length, 1);
      assert.equal(f.voiceRequests.filter(req => req.method === "DELETE").length, 1);
      assert.equal(f.providerRequests.filter(req => req.path.endsWith("/Calls.json")).length, 1);
      const status = await (await f.request("/status")).json(); assert.equal(status.pstnProvider, selection); assert.equal(status.activeCalls, 0);
    } finally { await f.close(); }
  }
}, 10_000);

test("explicit Vonage service selector preserves signed callbacks, NCCO and bidirectional PCM transport", async () => {
  const f = await fixture("accepted", "vonage");
  try {
    assert.equal((await (await f.request("/status")).json()).pstnProvider, "vonage");
    const call = await f.startCall(), dial = await f.dialed();
    assert.equal(dial.path, "/v1/calls");
    const jwt = dial.authorization.slice("Bearer ".length).split(".");
    assert.equal(JSON.parse(Buffer.from(jwt[0], "base64url").toString()).alg, "RS256");
    assert.equal(JSON.parse(Buffer.from(jwt[1], "base64url").toString()).application_id, "synthetic-vonage-app");
    assert.ok(verify("RSA-SHA256", Buffer.from(`${jwt[0]}.${jwt[1]}`), vonageKeyPair.publicKey, Buffer.from(jwt[2], "base64url")));
    const body = JSON.parse(dial.params);
    const token = body.ncco[0].endpoint[0].authorization.value.slice("Bearer ".length);
    assert.deepEqual(body, {
      to: [{ type: "phone", number: brief.to.slice(1) }], from: { type: "phone", number: "15555550200" },
      ncco: [{ action: "connect", endpoint: [{ type: "websocket", uri: "wss://phone.example/vonage/media",
        "content-type": "audio/l16;rate=16000", authorization: { type: "custom", value: `Bearer ${token}` }, headers: { callId: call.id } }] }],
      event_url: [`${callbackBase}/vonage/events/${call.id}`], event_method: "POST",
    });
    await eventually(async () => (await f.state(call.id)).dial_state === "accepted" ? true : undefined, "accepted Vonage dial");
    const events = `/vonage/events/${call.id}`;
    const completed = { uuid: callSid, status: "completed" };
    assert.equal((await f.vonageCallback(events, completed, null)).status, 403);
    assert.equal((await f.vonageCallback(events, completed, JSON.stringify({ uuid: callSid, status: "ringing" }))).status, 403);
    assert.equal((await f.state(call.id)).ended_at, null);
    assert.equal((await fetch(f.publicBase + "/vonage/media", { headers: {
      connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "c3ludGhldGljdGVzdGtleQ==",
      authorization: "Bearer unknown-provider-token",
    } })).status, 403);
    const provider = await f.connectProvider(token, "vonage");
    await eventually(async () => (await f.state(call.id)).status === "connected" ? true : undefined, "Vonage media connected");
    const inbound = Buffer.alloc(640), outbound = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) {
      inbound.writeInt16LE((i * 199) % 65536 - 32768, i * 2);
      outbound.writeInt16LE(32767 - (i * 113) % 65536, i * 2);
    }
    provider.socket.send(inbound);
    const input = await eventually(() => f.browserPackets.find(packet => packet.type === "pcm"), "unchanged Vonage PCM into browser");
    if (input.type !== "pcm") assert.fail();
    assert.deepEqual(Buffer.from(input.bytes, "base64"), inbound);
    f.output(outbound);
    const output = await eventually(() => provider.messages.find(message => Buffer.isBuffer(message)), "unchanged browser PCM into Vonage");
    assert.deepEqual(output, outbound);
    assert.equal((await f.vonageCallback(events, completed)).status, 200);
    await eventually(async () => (await f.state(call.id)).cleanup === 1 ? true : undefined, "Vonage and Voice cleanup");
    const stored = await f.state(call.id);
    assert.equal(stored.status, "completed"); assert.equal(stored.provider_kind, "vonage"); assert.equal(stored.provider_id, callSid);
    assert.equal(f.providerRequests.filter(req => req.method === "POST" && req.path === "/v1/calls").length, 1);
    assert.deepEqual(f.providerRequests.filter(req => req.method === "PUT").map(req => ({ path: req.path, body: JSON.parse(req.params) })),
      [{ path: `/v1/calls/${callSid}`, body: { action: "hangup" } }]);
    assert.equal(f.providerRequests.filter(req => req.path.includes("/Calls")).length, 0);
    assert.equal(f.voiceRequests.filter(req => req.method === "DELETE" && req.path === "/sessions/synthetic-voice-1").length, 1);
    assert.equal((await (await f.request("/status")).json()).activeCalls, 0);
  } finally { await f.close(); }
}, 10_000);

test("uncertain dial never replays; late signed callback after restart recovers and cleans provider identity", async () => {
  const f = await fixture("uncertain");
  try {
    const call = await f.startCall(); await f.dialed();
    await eventually(async () => (await f.state(call.id)).ended_at !== null ? true : undefined, "uncertain dial finished");
    let stored = await f.state(call.id);
    assert.equal(stored.status, "failed"); assert.equal(stored.dial_state, "uncertain");
    assert.equal(stored.provider_id, null); assert.equal(stored.cleanup, 0);
    assert.equal(f.hangups().length, 0);
    await f.restart(null);
    stored = await f.state(call.id);
    assert.equal(stored.dial_state, "uncertain"); assert.equal(stored.provider_id, null); assert.equal(stored.cleanup, 0);
    const path = `/signalwire/events/${call.id}`;
    assert.equal((await f.callback(path, { AccountSid: project, CallSid: callSid, CallStatus: "ringing" }, false)).status, 403);
    assert.equal((await f.state(call.id)).provider_id, null);
    assert.equal((await f.callback(path, { AccountSid: project, CallSid: callSid, CallStatus: "ringing" })).status, 200);
    await eventually(async () => (await f.state(call.id)).cleanup === 1 ? true : undefined, "late call identity cleanup");
    stored = await f.state(call.id);
    assert.equal(stored.provider_kind, "signalwire"); assert.equal(stored.provider_id, callSid); assert.equal(stored.dial_state, "accepted");
    assert.equal(f.hangups().length, 1);
    assert.equal(f.providerRequests.filter(req => req.path.endsWith("/Calls.json")).length, 1);
    assert.equal((await (await f.request("/status")).json()).activeCalls, 0);
  } finally { await f.close(); }
}, 10_000);
