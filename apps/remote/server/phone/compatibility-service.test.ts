import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash, createHmac, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const adminToken = "synthetic-compatibility-owner-token".padEnd(48, "a");
const project = "synthetic-project-id";
const signingKey = "synthetic-signing-key";
const vonageSigningKey = "synthetic-vonage-signature-secret";
const vonageKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const callSid = "76ac3c36-56da-4a3e-a0d6-b5f8df6da9ad";
const streamSid = "7d56cc11-536d-4a45-b4fb-ed3d55be843b";
const twilioAccountSid = "AC" + "a".repeat(32);
const twilioCallSid = "CA" + "b".repeat(32);
const twilioStreamSid = "MZ" + "c".repeat(32);
const twilioAuthToken = "synthetic-twilio-auth-token";
const callbackBase = "https://phone.example";
type ProviderKind = "signalwire" | "twilio" | "vonage";
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
function signature(url: string, params: URLSearchParams, key: string) {
  const data = url + [...params.keys()].sort().map(key => key + params.get(key)).join("");
  return createHmac("sha1", key).update(data).digest("base64");
}
type ProviderRequest = { method: string; host: string; path: string; params: string; authorization: string };

async function fixture(mode: "accepted" | "uncertain" = "accepted", initialProvider: ProviderKind = "signalwire") {
  const root = mkdtempSync(join(tmpdir(), "pi-compatibility-service-test-"));
  const providerSid = initialProvider === "twilio" ? twilioCallSid : callSid;
  const localPort = unusedPort(), publicPort = unusedPort();
  const base = `http://127.0.0.1:${localPort}`, publicBase = `http://127.0.0.1:${publicPort}`;
  const voiceRequests: { method: string; path: string; body: any }[] = [];
  const providerRequests: ProviderRequest[] = [];
  const browserPackets: ({ type: "pcm"; bytes: string } | { type: "control"; message: any })[] = [];
  const controls = new Set<Bun.ServerWebSocket<unknown>>();
  const sockets: WebSocket[] = [];
  let voiceCount = 0, providerDialCount = 0;
  const fake = Bun.serve({ hostname: "127.0.0.1", port: 0,
    websocket: { open(socket) { controls.add(socket); }, message() {}, close(socket) { controls.delete(socket); } },
    async fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path === "/control" && server.upgrade(req)) return;
      if (path === "/provider") {
        const request = await req.json() as ProviderRequest;
        providerRequests.push(request);
        if (request.path === "/v1/calls" && request.method === "POST") return Response.json({ uuid: providerSid, status: "started" });
        if (request.path === `/v1/calls/${providerSid}` && request.method === "PUT") return new Response(null, { status: 204 });
        if (request.path.endsWith("/Calls.json")) {
          providerDialCount++;
          const sid = initialProvider === "twilio" && providerDialCount > 1 ? "CA" + "d".repeat(32) : providerSid;
          return mode === "uncertain" ? Response.json({ error: "Synthetic uncertain dial" }, { status: 500 })
            : Response.json({ sid, status: "queued" });
        }
        return Response.json({ sid: providerSid, status: "completed" });
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
  writeFileSync(join(root, "twilio.json"), JSON.stringify({ TWILIO_ACCOUNT_SID: twilioAccountSid,
    TWILIO_AUTH_TOKEN: twilioAuthToken, TWILIO_FROM_NUMBER: "+15555550300" }), { mode: 0o600 });
  function configure(pstnProvider: ProviderKind | null) {
    writeFileSync(join(root, "config.json"), JSON.stringify({
      owner: "synthetic-test-owner", adminTokenFile: join(root, "admin-token"), localPort, publicPort,
      pstnProvider, callingEnabled: true, publicBaseUrl: callbackBase,
      signalwireCredentialFile: join(root, "signalwire.json"), twilioCredentialFile: join(root, "twilio.json"), vonageCredentialFile: join(root, "vonage.json"),
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
  if (url.hostname === 'synthetic-test.signalwire.com' || url.hostname === 'api.nexmo.com' || url.hostname === 'api.twilio.com') return nativeFetch(testBase + '/provider', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      method: options.method, host: url.host, path: url.pathname, params: options.body?.toString() ?? '', authorization: options.headers.authorization,
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
  async function dialed(index = 0) {
    return eventually(() => providerRequests.filter(request => request.method === "POST" && (request.path.endsWith("/Calls.json") || request.path === "/v1/calls"))[index], "synthetic provider dial");
  }
  async function callback(path: string, fields: Record<string, string>, signed = true, signedFields = fields, signedUrl = callbackBase + path) {
    const params = new URLSearchParams(fields), kind = path.startsWith("/twilio/") ? "twilio" : "signalwire";
    return fetch(publicBase + path, { method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded", ...(signed ? { [`x-${kind}-signature`]: signature(signedUrl, new URLSearchParams(signedFields), kind === "twilio" ? twilioAuthToken : signingKey) } : {}),
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
  async function connectSocket(path: string, headers: Record<string, string>) {
    const Client = WebSocket as typeof WebSocket & { new(url: string, options: Bun.WebSocketOptions): WebSocket };
    const socket = new Client(`${publicBase.replace("http:", "ws:")}${path}`, { headers });
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
  function connectProvider(token: string, kind: "signalwire" | "vonage" = "signalwire") {
    return connectSocket(`/${kind}/media`, { authorization: `Bearer ${token}` });
  }
  function connectTwilio(url: string, signedUrl = url) {
    const parsed = new URL(url);
    return connectSocket(parsed.pathname + parsed.search, { "x-twilio-signature": signature(signedUrl, new URLSearchParams(), twilioAuthToken) });
  }
  function upgrade(path: string, headers: Record<string, string> = {}) {
    return fetch(publicBase + path, { headers: { connection: "Upgrade", upgrade: "websocket",
      "sec-websocket-version": "13", "sec-websocket-key": "c3ludGhldGljdGVzdGtleQ==", ...headers }, signal: AbortSignal.timeout(1000) });
  }
  async function restart(selection: ProviderKind | null) {
    await stop("SIGKILL"); configure(selection); spawn(); await ready();
  }
  function output(pcm: Buffer) {
    assert.equal(controls.size, 1);
    for (const socket of controls) socket.send(JSON.stringify({ type: "pcm", bytes: pcm.toString("base64") }));
  }
  const hangups = () => providerRequests.filter(r => r.method === "POST" && r.path.endsWith(`/Calls/${providerSid}.json`) && new URLSearchParams(r.params).get("Status") === "completed");
  return { request, publicBase, startCall, state, dialed, callback, vonageCallback, connectProvider, connectTwilio, upgrade, restart, output, close, hangups, providerRequests, voiceRequests, browserPackets };
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

function twilioStreamUrl(request: ProviderRequest, id: string) {
  const params = new URLSearchParams(request.params), twiml = params.get("Twiml");
  assert.ok(twiml); assert.equal(params.has("Laml"), false);
  assert.doesNotMatch(twiml, /authBearerToken|authorization|codec=/i);
  const match = /<Stream\b[^>]*\burl="([^"]+)"/.exec(twiml); assert.ok(match);
  const url = new URL(match[1].replaceAll("&amp;", "&"));
  assert.equal(url.origin, "wss://phone.example");
  const segments = url.pathname.split("/");
  assert.deepEqual(segments.slice(0, 4), ["", "twilio", "media", id]);
  assert.equal(segments.length, 5); assert.match(segments[4], /^[A-Za-z0-9_-]{32,}$/);
  assert.notEqual(segments[4], adminToken); assert.equal(url.search, "");
  return url.href;
}
function twilioStart(socket: WebSocket, fields: Record<string, unknown> = {}) {
  socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  socket.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid: twilioStreamSid, start: {
    streamSid: twilioStreamSid, callSid: twilioCallSid, accountSid: twilioAccountSid, tracks: ["inbound"],
    mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }, ...fields,
  } }));
}
function assertTone(samples: number[], rate: number, minRms: number, maxRms: number) {
  const settled = samples.slice(80);
  let energy = 0, sine = 0, cosine = 0;
  for (let i = 0; i < settled.length; i++) {
    const phase = 2 * Math.PI * 1000 * i / rate;
    energy += settled[i] ** 2;
    sine += settled[i] * Math.sin(phase); cosine += settled[i] * Math.cos(phase);
  }
  const rms = Math.sqrt(energy / settled.length);
  assert.ok(rms > minRms && rms < maxRms, `Speech amplitude ${rms} outside ${minRms}..${maxRms}`);
  assert.ok(2 * (sine ** 2 + cosine ** 2) / (settled.length * energy) > 0.98, "1 kHz speech tone lost in conversion");
}
function pcmSamples(bytes: Buffer) {
  assert.equal(bytes.length % 2, 0);
  return Array.from({ length: bytes.length / 2 }, (_, index) => bytes.readInt16LE(index * 2));
}
function mulawSamples(bytes: Buffer) {
  return [...bytes].map(byte => {
    const value = 255 - byte, sign = value >= 128 ? -1 : 1, exponent = Math.floor((value % 128) / 16);
    return sign * ((132 + 8 * (value % 16)) * 2 ** exponent - 132);
  });
}

test("Twilio callbacks authenticate the exact external URL, form and account before creating any call", async () => {
  const f = await fixture("accepted", "twilio");
  try {
    for (const path of ["/twilio/answer", "/twilio/events/missing-call"]) {
      const fields = { AccountSid: twilioAccountSid, CallSid: twilioCallSid, CallStatus: "completed" };
      assert.equal((await f.callback(path, fields, false)).status, 403);
      assert.equal((await f.callback(path, { ...fields, AccountSid: "AC" + "e".repeat(32) })).status, 403);
      assert.equal((await f.callback(path, { CallSid: twilioCallSid })).status, 403);
      assert.equal((await f.callback(path, fields, true, { ...fields, CallStatus: "ringing" })).status, 403);
      assert.equal((await f.callback(path, fields, true, fields, "https://attacker.example" + path)).status, 403);
      assert.equal((await f.callback(path, fields, true, fields, callbackBase + path + "?altered=true")).status, 403);
    }
    const unknown = "/twilio/media/missing-call/" + "x".repeat(48);
    assert.equal((await f.upgrade(unknown, { "x-twilio-signature": signature("wss://phone.example" + unknown, new URLSearchParams(), twilioAuthToken) })).status, 403);
    assert.deepEqual(await (await f.request("/calls")).json(), []);
    assert.equal(f.providerRequests.length, 0); assert.equal(f.voiceRequests.length, 0);
  } finally { await f.close(); }
}, 10_000);

test("Twilio signed media needs no bearer, dials once and bridges nonzero PCMU/PCM speech both ways", async () => {
  const f = await fixture("accepted", "twilio");
  try {
    const call = await f.startCall(), dial = await f.dialed(), streamUrl = twilioStreamUrl(dial, call.id);
    assert.equal(dial.host, "api.twilio.com");
    assert.equal(dial.path, `/2010-04-01/Accounts/${twilioAccountSid}/Calls.json`);
    assert.equal(dial.authorization, `Basic ${Buffer.from(twilioAccountSid + ":" + twilioAuthToken).toString("base64")}`);
    const params = new URLSearchParams(dial.params);
    assert.equal(params.get("To"), brief.to); assert.equal(params.get("From"), "+15555550300");
    assert.equal(params.get("StatusCallback"), `${callbackBase}/twilio/events/${call.id}`);
    assert.equal(params.get("Timeout"), "30");
    await eventually(async () => (await f.state(call.id)).dial_state === "accepted" ? true : undefined, "accepted Twilio call");
    const path = new URL(streamUrl).pathname;
    const rejectedHeaders: Record<string, string>[] = [{}, { authorization: `Bearer ${adminToken}` }, { "x-twilio-signature": "invalid-signature" },
      { "x-twilio-signature": signature(streamUrl + "?altered=true", new URLSearchParams(), twilioAuthToken) },
      { "x-twilio-signature": signature(streamUrl.replace("phone.example", "attacker.example"), new URLSearchParams(), twilioAuthToken), "x-forwarded-host": "attacker.example" },
      { "x-twilio-signature": signature(f.publicBase + path, new URLSearchParams(), twilioAuthToken) },
      { "x-twilio-signature": signature(streamUrl, new URLSearchParams(), "wrong-token") }];
    for (const headers of rejectedHeaders) {
      assert.equal((await f.upgrade(path, headers)).status, 403);
    }
    assert.equal((await f.upgrade(path + "?altered=true", { "x-twilio-signature": signature(streamUrl, new URLSearchParams(), twilioAuthToken) })).status, 403);
    const wrongNoncePath = path.slice(0, path.lastIndexOf("/") + 1) + "z".repeat(48);
    assert.equal((await f.upgrade(wrongNoncePath, { "x-twilio-signature": signature("wss://phone.example" + wrongNoncePath, new URLSearchParams(), twilioAuthToken) })).status, 403);
    const provider = await f.connectTwilio(streamUrl); twilioStart(provider.socket);
    await eventually(async () => (await f.state(call.id)).status === "connected" ? true : undefined, "Twilio stream start");
    assert.equal((await f.upgrade(path, { "x-twilio-signature": signature(streamUrl, new URLSearchParams(), twilioAuthToken) })).status, 403);
    const codes = [255, 166, 156, 166, 255, 38, 28, 38];
    const inbound = Buffer.from(Array.from({ length: 160 }, (_, index) => codes[index % codes.length]));
    provider.socket.send(JSON.stringify({ event: "media", sequenceNumber: "2", streamSid: twilioStreamSid,
      media: { track: "inbound", chunk: "1", timestamp: "0", payload: inbound.toString("base64") } }));
    const packet = await eventually(() => f.browserPackets.find(packet => packet.type === "pcm"), "nonzero browser speech");
    if (packet.type !== "pcm") assert.fail();
    const pcm = Buffer.from(packet.bytes, "base64"); assert.equal(pcm.length, 640);
    assertTone(pcmSamples(pcm), 16000, 6000, 7200);
    const outbound = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) outbound.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 1000 * i / 16000)), i * 2);
    f.output(outbound);
    const outgoing = await eventually(() => provider.messages.find(message => message.event === "media"), "nonzero Twilio speech");
    assert.equal(outgoing.streamSid, twilioStreamSid);
    const mulaw = Buffer.from(outgoing.media.payload, "base64"); assert.equal(mulaw.length, 160);
    assertTone(mulawSamples(mulaw), 8000, 5300, 6000);
    assert.ok(f.browserPackets.some(packet => packet.type === "control" && packet.message.type === "context"));
    const events = `/twilio/events/${call.id}`;
    assert.equal((await f.callback(events, { AccountSid: twilioAccountSid, CallSid: "CA" + "e".repeat(32), CallStatus: "completed" })).status, 403);
    assert.equal((await f.state(call.id)).ended_at, null);
    assert.equal((await f.callback(events, { AccountSid: twilioAccountSid, CallSid: twilioCallSid, CallStatus: "completed" })).status, 200);
    await eventually(async () => (await f.state(call.id)).cleanup === 1 ? true : undefined, "Twilio cleanup");
    const stored = await f.state(call.id);
    assert.equal(stored.status, "completed"); assert.equal(stored.provider_kind, "twilio"); assert.equal(stored.provider_id, twilioCallSid);
    assert.equal(f.hangups().length, 1);
    assert.equal(f.voiceRequests.filter(req => req.method === "DELETE" && req.path === "/sessions/synthetic-voice-1").length, 1);
    assert.equal(f.providerRequests.filter(req => req.path.endsWith("/Calls.json")).length, 1);
    assert.equal((await (await f.request("/status")).json()).activeCalls, 0);
    assert.equal((await f.upgrade(path, { "x-twilio-signature": signature(streamUrl, new URLSearchParams(), twilioAuthToken) })).status, 403);
  } finally { await f.close(); }
}, 10_000);

test("Twilio media nonce is scoped to the live call and atomically consumed across signed upgrades", async () => {
  const f = await fixture("accepted", "twilio");
  try {
    const first = await f.startCall(), firstUrl = twilioStreamUrl(await f.dialed(), first.id);
    const second = await f.startCall(), secondUrl = twilioStreamUrl(await f.dialed(1), second.id);
    await eventually(async () => (await f.state(second.id)).dial_state === "accepted" ? true : undefined, "second accepted Twilio call");
    assert.notEqual(new URL(firstUrl).pathname.split("/").at(-1), new URL(secondUrl).pathname.split("/").at(-1));
    const swapped = new URL(firstUrl).pathname.replace(first.id, second.id);
    assert.equal((await f.upgrade(swapped, { "x-twilio-signature": signature("wss://phone.example" + swapped, new URLSearchParams(), twilioAuthToken) })).status, 403);
    const queriedUrl = firstUrl + "?provider-test=signed";
    const httpsSignedUrl = queriedUrl.replace("wss:", "https:");
    const attempts = await Promise.allSettled([f.connectTwilio(queriedUrl, httpsSignedUrl), f.connectTwilio(queriedUrl, httpsSignedUrl)]);
    assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter(result => result.status === "rejected").length, 1);
    const success = attempts.find(result => result.status === "fulfilled");
    if (!success || success.status !== "fulfilled") assert.fail();
    twilioStart(success.value.socket);
    await eventually(async () => (await f.state(first.id)).status === "connected" ? true : undefined, "single owned upgrade");
    assert.equal((await f.request(`/calls/${first.id}`, "DELETE")).status, 200);
    assert.equal((await f.request(`/calls/${second.id}`, "DELETE")).status, 200);
    assert.equal((await (await f.request("/status")).json()).activeCalls, 0);
  } finally { await f.close(); }
}, 10_000);

test("Twilio invalid codec, account, call or malformed media terminates and cleans the owned call", async () => {
  for (const invalid of ["codec", "account", "call", "media"] as const) {
    const f = await fixture("accepted", "twilio");
    try {
      const call = await f.startCall(), streamUrl = twilioStreamUrl(await f.dialed(), call.id);
      await eventually(async () => (await f.state(call.id)).dial_state === "accepted" ? true : undefined, "accepted Twilio call");
      const provider = await f.connectTwilio(streamUrl);
      twilioStart(provider.socket, invalid === "codec" ? { mediaFormat: { encoding: "audio/pcm", sampleRate: 16000, channels: 1 } }
        : invalid === "account" ? { accountSid: "AC" + "e".repeat(32) }
        : invalid === "call" ? { callSid: "CA" + "e".repeat(32) } : {});
      if (invalid === "media") {
        await eventually(async () => (await f.state(call.id)).status === "connected" ? true : undefined, "valid Twilio start");
        provider.socket.send(JSON.stringify({ event: "media", sequenceNumber: "2", streamSid: twilioStreamSid, media: { track: "inbound", chunk: "1", timestamp: "0", payload: "not-base64!" } }));
      }
      await eventually(async () => (await f.state(call.id)).cleanup === 1 ? true : undefined, `${invalid} failure cleanup`);
      const stored = await f.state(call.id); assert.equal(stored.status, "failed");
      assert.match(stored.error, invalid === "codec" ? /unsupported-codec/ : invalid === "media" ? /invalid-media/ : /identity-mismatch/);
      assert.equal(f.hangups().length, 1); assert.equal(f.voiceRequests.filter(req => req.method === "DELETE").length, 1);
      assert.equal(f.browserPackets.filter(packet => packet.type === "pcm").length, 0);
      assert.equal((await (await f.request("/status")).json()).activeCalls, 0);
    } finally { await f.close(); }
  }
}, 15_000);

test("restart cleans stored Twilio calls after selecting SignalWire, Vonage or SIM-only", async () => {
  for (const selection of ["signalwire", "vonage", null] as const) {
    const f = await fixture("accepted", "twilio");
    try {
      const call = await f.startCall(); await f.dialed();
      await eventually(async () => (await f.state(call.id)).dial_state === "accepted" ? true : undefined, "Twilio accepted before crash");
      await f.restart(selection);
      const stored = await f.state(call.id);
      assert.equal(stored.status, "interrupted"); assert.equal(stored.provider_kind, "twilio");
      assert.equal(stored.provider_id, twilioCallSid); assert.equal(stored.cleanup, 1);
      assert.equal(f.hangups().length, 1); assert.equal(f.hangups()[0].host, "api.twilio.com");
      assert.equal(f.voiceRequests.filter(req => req.method === "DELETE").length, 1);
      assert.equal(f.providerRequests.filter(req => req.path.endsWith("/Calls.json")).length, 1);
      const status = await (await f.request("/status")).json(); assert.equal(status.pstnProvider, selection); assert.equal(status.activeCalls, 0);
    } finally { await f.close(); }
  }
}, 15_000);

test("uncertain Twilio one-shot dial learns identity from late signed callback after provider switch", async () => {
  const f = await fixture("uncertain", "twilio");
  try {
    const call = await f.startCall(); await f.dialed();
    await eventually(async () => (await f.state(call.id)).ended_at !== null ? true : undefined, "uncertain Twilio finished");
    let stored = await f.state(call.id);
    assert.equal(stored.status, "failed"); assert.equal(stored.dial_state, "uncertain");
    assert.equal(stored.provider_id, null); assert.equal(stored.cleanup, 0); assert.equal(f.hangups().length, 0);
    await f.restart("signalwire");
    const path = `/twilio/events/${call.id}`, fields = { AccountSid: twilioAccountSid, CallSid: twilioCallSid, CallStatus: "ringing" };
    assert.equal((await f.callback(path, fields, false)).status, 403);
    assert.equal((await f.callback(path, fields, true, { ...fields, CallSid: "CA" + "e".repeat(32) })).status, 403);
    assert.equal((await f.state(call.id)).provider_id, null);
    assert.equal((await f.callback(path, fields)).status, 200);
    await eventually(async () => (await f.state(call.id)).cleanup === 1 ? true : undefined, "late Twilio identity cleanup");
    stored = await f.state(call.id);
    assert.equal(stored.provider_kind, "twilio"); assert.equal(stored.provider_id, twilioCallSid); assert.equal(stored.dial_state, "accepted");
    const cleanupRequests = f.providerRequests.length, voiceDeletes = f.voiceRequests.filter(req => req.method === "DELETE").length;
    assert.equal((await f.callback(path, fields)).status, 200);
    assert.equal((await f.callback(path, { ...fields, CallStatus: "completed" })).status, 200);
    assert.equal(f.providerRequests.length, cleanupRequests);
    assert.equal(f.voiceRequests.filter(req => req.method === "DELETE").length, voiceDeletes);
    assert.equal((await f.state(call.id)).cleanup, 1);
    assert.equal(f.hangups().length, 1);
    assert.equal(f.providerRequests.filter(req => req.path.endsWith("/Calls.json")).length, 1);
    assert.ok(f.voiceRequests.some(req => req.method === "DELETE" && req.path === "/sessions/synthetic-voice-1"));
    assert.equal((await (await f.request("/status")).json()).activeCalls, 0);
  } finally { await f.close(); }
}, 10_000);

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
