import { test } from "bun:test";
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const adminToken = "synthetic-retell-owner-token".padEnd(48, "a");
const apiKey = "synthetic-retell-api-key";
const agentId = "agent_synthetic_retell";
const fromNumber = "+15555550100";
const privateMarker = "PRIVATE_CONTEXT_MUST_NOT_REACH_RETELL";
const brief = {
  to: "+442079460123", purpose: "Ask whether the synthetic shop opens on Sunday.",
  shareableFacts: ["This is an offline integration fixture."],
  opening: "Hello, I'm Kenan, an AI assistant. Is the shop open on Sunday?", maxSeconds: 60,
};
type ProviderRequest = { method: string; host: string; path: string; authorization: string | null; body: any };
type Snapshot = { call_id: string; call_status: string; [key: string]: unknown };
type StoredCall = { id: string; provider_kind: string; provider_id: string | null; provider_snapshot: string | null; voice_id: string | null; dial_state: string; status: string; ended_at: number | null; cleanup: number; error: string | null; brief: string };

async function eventually<T>(read: () => T | undefined | Promise<T | undefined>, description: string): Promise<T> {
  const deadline = Date.now() + 4000;
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

async function fixture(accelerateDuration = false) {
  const root = mkdtempSync(join(tmpdir(), "pi-retell-service-test-"));
  const localPort = unusedPort(), publicPort = unusedPort();
  const providerRequests: ProviderRequest[] = [];
  const forbiddenEffects: { kind: string; [key: string]: unknown }[] = [];
  const durationTimers: number[] = [];
  const snapshots = new Map<string, Snapshot>();
  let dialCount = 0;
  const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/forbidden") { forbiddenEffects.push(await req.json()); return Response.json({ ok: true }); }
    if (path === "/duration-timer") { durationTimers.push((await req.json()).milliseconds); return Response.json({ ok: true }); }
    if (path !== "/provider") {
      forbiddenEffects.push({ kind: "voice", method: req.method, path });
      return Response.json({ error: "Voice must not be used by Retell" }, { status: 500 });
    }
    const request = await req.json() as ProviderRequest;
    providerRequests.push(request);
    if (request.method === "POST" && request.path === "/v2/create-phone-call") {
      const call_id = `call_synthetic_${++dialCount}`;
      const snapshot = { call_id, call_type: "phone_call", call_status: "registered", agent_id: agentId, from_number: fromNumber, to_number: brief.to };
      snapshots.set(call_id, snapshot);
      return Response.json(snapshot);
    }
    const match = /^\/v2\/(get-call|stop-call)\/(call_synthetic_\d+)$/.exec(request.path);
    if (match && snapshots.has(match[2])) {
      if (match[1] === "get-call" && request.method === "GET") return Response.json(snapshots.get(match[2]));
      if (match[1] === "stop-call" && request.method === "POST") {
        snapshots.set(match[2], { ...snapshots.get(match[2])!, call_status: "ended", disconnection_reason: "agent_hangup" });
        return new Response(null, { status: 204 });
      }
    }
    return Response.json({ error: "Unexpected synthetic Retell request" }, { status: 400 });
  } });
  writeFileSync(join(root, "admin-token"), adminToken, { mode: 0o600 });
  writeFileSync(join(root, "retell.json"), JSON.stringify({ RETELL_API_KEY: apiKey, RETELL_AGENT_ID: agentId, RETELL_AGENT_VERSION: 0, RETELL_FROM_NUMBER: fromNumber }), { mode: 0o600 });
  writeFileSync(join(root, "private-notes"), privateMarker, { mode: 0o600 });
  function configure(pstnProvider: "retell" | null) {
    writeFileSync(join(root, "config.json"), JSON.stringify({
      owner: privateMarker, adminTokenFile: join(root, "admin-token"), localPort, publicPort,
      pstnProvider, callingEnabled: true, retellCredentialFile: join(root, "retell.json"),
      voiceUrl: `http://127.0.0.1:${fake.port}`, chromium: join(root, "never-launch-a-browser"),
      privateContext: privateMarker,
    }));
  }
  configure("retell");
  // Only external effects and elapsed time are substituted. The deployed service,
  // SQLite, authentication, brief validation and cleanup run in a fresh process.
  writeFileSync(join(root, "runner.ts"), `
import { mock } from 'bun:test';
const nativeFetch = globalThis.fetch;
const testBase = process.env.TEST_FAKE_BASE;
const report = (path, body) => nativeFetch(testBase + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
globalThis.fetch = (async (input, options) => {
  const request = new Request(input, options);
  const url = new URL(request.url);
  if (url.hostname === 'api.retellai.com') return report('/provider', {
    method: request.method, host: url.host, path: url.pathname,
    authorization: request.headers.get('authorization'),
    body: request.method === 'GET' ? null : JSON.parse((await request.text()) || 'null'),
  });
  if (url.hostname === '127.0.0.1' && url.port === new URL(testBase).port) return nativeFetch(request);
  await report('/forbidden', { kind: 'external-fetch', url: request.url });
  throw new Error('External fetch forbidden in integration test');
});
mock.module(${JSON.stringify(Bun.resolveSync("playwright-core", new URL(".", import.meta.url).pathname))}, () => ({ chromium: { async launch() {
  await report('/forbidden', { kind: 'chromium-launch' });
  throw new Error('Retell must not allocate Chromium');
} } }));
mock.module(${JSON.stringify(Bun.resolveSync("kenan-memory/journal", new URL(".", import.meta.url).pathname))}, () => ({
  actionJournal: { begin(spec) { return { id: 'synthetic-journal', spec }; }, finish() { return { ok: true }; } },
  journalWarning() { return null; },
}));
const nativeTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((callback, milliseconds, ...args) => {
  if (milliseconds >= 30000) {
    void report('/duration-timer', { milliseconds });
    if (process.env.TEST_ACCELERATE_DURATION === '1' && milliseconds === 60000) milliseconds = 100;
  }
  return nativeTimeout(callback, milliseconds, ...args);
});
await import(${JSON.stringify(new URL("./service.ts", import.meta.url).href)});
`);
  const launchChild = () => Bun.spawn([process.execPath, join(root, "runner.ts")], {
    env: { PATH: process.env.PATH!, HOME: root, USER: "synthetic-test-owner", TZ: "UTC",
      PI_STACK_PHONE_CONFIG: join(root, "config.json"), PI_STACK_PHONE_STATE: join(root, "state"),
      TEST_FAKE_BASE: `http://127.0.0.1:${fake.port}`, TEST_ACCELERATE_DURATION: accelerateDuration ? "1" : "0" },
    stdout: "ignore", stderr: "pipe",
  });
  let child: ReturnType<typeof launchChild>;
  let stderr: Promise<string>;
  let database: Database | undefined;
  function spawn() { child = launchChild(); stderr = new Response(child.stderr).text(); }
  const request = (path: string, method = "GET", body?: unknown, token: string | null = adminToken) => fetch(`http://127.0.0.1:${localPort}${path}`, {
    method, headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(1000),
  });
  async function ready() {
    await eventually(async () => {
      try { if ((await request("/status")).ok) return true; } catch {}
      if (child.exitCode !== null) throw new Error(`Service exited: ${await stderr}`);
    }, "Retell service ready");
  }
  async function stop(signal: "SIGTERM" | "SIGKILL") {
    if (child.exitCode !== null) return;
    child.kill(signal);
    const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
    await child.exited; clearTimeout(timer);
  }
  async function close() {
    await stop("SIGTERM"); database?.close(); fake.stop(true); rmSync(root, { recursive: true, force: true });
  }
  spawn();
  try { await ready(); } catch (cause) { await close(); throw cause; }
  database = new Database(join(root, "state", "calls.sqlite3"), { readonly: true });
  function stored(id: string) { return database!.query("SELECT * FROM calls WHERE id=?").get(id) as StoredCall; }
  async function show(id: string) { const response = await request(`/calls/${id}`); assert.equal(response.status, 200); return response.json(); }
  async function start(approved: unknown = brief) {
    const response = await request("/calls", "POST", approved); assert.equal(response.status, 202);
    const call = await response.json() as { id: string };
    await eventually(() => stored(call.id).dial_state === "accepted" ? true : undefined, "Retell dial accepted");
    return call;
  }
  async function restart(selection: "retell" | null) { await stop("SIGKILL"); configure(selection); spawn(); await ready(); }
  function snapshot(id: string, update: Record<string, unknown>) {
    const providerId = stored(id).provider_id; assert.ok(providerId);
    snapshots.set(providerId, { ...snapshots.get(providerId)!, ...update });
  }
  const dials = () => providerRequests.filter(r => r.method === "POST" && r.path === "/v2/create-phone-call");
  const hangups = () => providerRequests.filter(r => r.method === "POST" && r.path.startsWith("/v2/stop-call/"));
  function assertIsolated() {
    assert.deepEqual(forbiddenEffects, []);
    const externallySent = JSON.stringify(providerRequests);
    for (const secret of [privateMarker, adminToken, join(root, "private-notes")]) assert.ok(!externallySent.includes(secret), `Private context leaked: ${secret}`);
  }
  return { request, start, stored, show, restart, snapshot, close, providerRequests, dials, hangups, assertIsolated, durationTimers };
}

function decoded(value: unknown): any { return typeof value === "string" ? JSON.parse(value) : value; }

test("Retell owner auth and invalid briefs reject before allocating provider, Chromium or Voice", async () => {
  const f = await fixture();
  try {
    const status = await (await f.request("/status")).json();
    assert.equal(status.pstnProvider, "retell"); assert.equal(status.model, "retell-llm"); assert.equal(status.storedCallerId, fromNumber);
    for (const token of [null, "wrong-token"]) {
      assert.equal((await f.request("/status", "GET", undefined, token)).status, 403);
      assert.equal((await f.request("/calls", "POST", brief, token)).status, 403);
    }
    for (const invalid of [null, { ...brief, to: "not-a-number" }, { ...brief, purpose: "" },
      { ...brief, shareableFacts: [1] }, { ...brief, privateContext: privateMarker },
      ...[0, 29, 30, 59, 60.5, 601, 1800].map(maxSeconds => ({ ...brief, maxSeconds }))]) {
      const response = await f.request("/calls", "POST", invalid);
      assert.equal(response.status, 400); assert.equal(typeof (await response.json()).error, "string");
    }
    assert.deepEqual(await (await f.request("/calls")).json(), []);
    assert.equal(f.providerRequests.length, 0); assert.equal(f.durationTimers.length, 0); f.assertIsolated();
  } finally { await f.close(); }
}, 10_000);

test("Retell sends only approved brief, refuses live context explicitly and owner end cleans its provider ID", async () => {
  const f = await fixture();
  try {
    const call = await f.start();
    const dial = f.dials()[0]; assert.ok(dial);
    assert.equal(dial.host, "api.retellai.com"); assert.equal(dial.authorization, `Bearer ${apiKey}`);
    assert.equal(dial.body.from_number, fromNumber); assert.equal(dial.body.to_number, brief.to);
    assert.equal(dial.body.override_agent_id, agentId); assert.equal(dial.body.override_agent_version, 0);
    assert.equal(dial.body.agent_override.agent.max_call_duration_ms, 60000);
    assert.equal(dial.body.agent_override.retell_llm.begin_message, brief.opening);
    assert.deepEqual(dial.body.agent_override.retell_llm.knowledge_base_ids, []);
    assert.deepEqual(Object.keys(dial.body.retell_llm_dynamic_variables).sort(), ["approved_call_prompt", "approved_opening"]);
    const outbound = JSON.stringify(dial.body);
    for (const fact of [brief.purpose, brief.opening, ...brief.shareableFacts]) assert.ok(outbound.includes(fact));
    assert.ok(!outbound.includes(apiKey));
    const stored = f.stored(call.id);
    assert.equal(stored.provider_kind, "retell"); assert.equal(stored.voice_id, null);
    const requestsBefore = f.providerRequests.length;
    const context = await f.request(`/calls/${call.id}/context`, "POST", { shareableFact: privateMarker });
    assert.equal(context.status, 409); assert.match((await context.json()).error, /retell|unsupported|not supported/i);
    assert.equal(f.dials().length, 1);
    assert.ok(f.providerRequests.slice(requestsBefore).every(r => r.method === "GET"));
    assert.equal((await f.request(`/calls/${call.id}`, "DELETE")).status, 200);
    await eventually(() => f.stored(call.id).cleanup === 1 ? true : undefined, "owner-end cleanup");
    assert.equal(f.stored(call.id).status, "completed"); assert.ok(f.stored(call.id).ended_at);
    assert.deepEqual(f.hangups().map(r => r.path), [`/v2/stop-call/${stored.provider_id}`]);
    assert.equal((await (await f.request("/status")).json()).activeCalls, 0); f.assertIsolated();
  } finally { await f.close(); }
}, 10_000);

test("Retell polling and show refresh persist completed transcript, analysis and cost across restart", async () => {
  const f = await fixture();
  try {
    const call = await f.start();
    await eventually(() => decoded(f.stored(call.id).provider_snapshot)?.call_status === "registered" ? true : undefined, "initial Retell synchronization");
    const readsBeforePoll = f.providerRequests.filter(r => r.method === "GET").length;
    f.snapshot(call.id, { call_status: "ongoing", transcript: "Agent: Is the shop open on Sunday?" });
    await eventually(() => {
      const snapshot = decoded(f.stored(call.id).provider_snapshot);
      return snapshot?.transcript === "Agent: Is the shop open on Sunday?" ? true : undefined;
    }, "background Retell polling without owner show");
    assert.ok(f.providerRequests.filter(r => r.method === "GET").length > readsBeforePoll);
    const completed = { call_status: "ended", transcript: "Agent: Is the shop open on Sunday?\nUser: Yes, until five.",
      call_analysis: { call_summary: "The shop opens on Sunday until five.", call_successful: true },
      call_cost: { combined_cost: 12.5, total_duration_seconds: 42, total_duration_unit_price: 0.298,
        product_costs: [{ product: "synthetic_voice", unit_price: 0.298, cost: 12.5 }] },
      disconnection_reason: "user_hangup", start_timestamp: 1000, end_timestamp: 43000 };
    f.snapshot(call.id, completed);
    const shown = await f.show(call.id);
    const refreshed = decoded(shown.call.provider_snapshot);
    for (const key of ["transcript", "call_analysis", "call_cost"] as const) assert.deepEqual(refreshed[key], completed[key]);
    await eventually(() => f.stored(call.id).cleanup === 1 ? true : undefined, "completed Retell cleanup");
    const final = await f.show(call.id);
    assert.equal(final.call.status, "completed"); assert.equal(final.call.voice_id, null);
    assert.ok(final.events.some((event: { type: string; payload: unknown }) => {
      const payload = decoded(event.payload);
      return event.type === "retell-call" && payload.transcript === completed.transcript &&
        JSON.stringify(payload.call_analysis) === JSON.stringify(completed.call_analysis) && JSON.stringify(payload.call_cost) === JSON.stringify(completed.call_cost);
    }), "Completion evidence must be retained in the event history");
    const beforeRestart = f.stored(call.id).provider_snapshot;
    await f.restart(null);
    assert.equal(f.stored(call.id).provider_snapshot, beforeRestart);
    assert.equal(f.stored(call.id).status, "completed"); assert.equal(f.dials().length, 1);
    assert.equal((await (await f.request("/status")).json()).activeCalls, 0); f.assertIsolated();
  } finally { await f.close(); }
}, 10_000);

test("Retell restart ends stored accepted call using its provider kind even with PSTN now unset; never redials", async () => {
  const f = await fixture();
  try {
    const call = await f.start(), providerId = f.stored(call.id).provider_id;
    await f.restart(null);
    const stored = f.stored(call.id);
    assert.equal(stored.status, "interrupted"); assert.equal(stored.provider_kind, "retell");
    assert.equal(stored.provider_id, providerId); assert.equal(stored.voice_id, null); assert.equal(stored.cleanup, 1);
    assert.deepEqual(f.hangups().map(r => r.path), [`/v2/stop-call/${providerId}`]);
    assert.equal(f.dials().length, 1);
    const status = await (await f.request("/status")).json(); assert.equal(status.pstnProvider, null); assert.equal(status.activeCalls, 0);
    await f.restart(null);
    assert.equal(f.hangups().length, 1); assert.equal(f.dials().length, 1); f.assertIsolated();
  } finally { await f.close(); }
}, 10_000);

test("Retell per-call duration is bounded to 600 seconds and reaching the brief limit ends its provider ID", async () => {
  const f = await fixture(true);
  try {
    const call = await f.start({ ...brief, maxSeconds: 60 });
    await eventually(() => f.stored(call.id).cleanup === 1 ? true : undefined, "maximum-duration cleanup");
    const stored = f.stored(call.id);
    assert.equal(stored.status, "completed"); assert.match(stored.error!, /maximum call duration/i);
    assert.equal(f.dials().length, 1); assert.deepEqual(f.hangups().map(r => r.path), [`/v2/stop-call/${stored.provider_id}`]);
    assert.ok(f.durationTimers.includes(60000));
    const bounded = await f.start({ ...brief, maxSeconds: 600 });
    assert.ok(f.durationTimers.includes(600000));
    assert.equal((await f.request(`/calls/${bounded.id}`, "DELETE")).status, 200);
    const { maxSeconds: _unused, ...withoutDuration } = brief;
    const implicit = await f.start(withoutDuration);
    const providerDuration = f.dials().at(-1)!.body.agent_override.agent.max_call_duration_ms;
    assert.ok(Number.isInteger(providerDuration) && providerDuration >= 60000 && providerDuration <= 600000);
    assert.ok(f.durationTimers.includes(300000), "The local default call timer must remain bounded");
    assert.ok(f.durationTimers.every(milliseconds => milliseconds <= 600000));
    assert.equal((await f.request(`/calls/${implicit.id}`, "DELETE")).status, 200);
    assert.equal((await (await f.request("/status")).json()).activeCalls, 0); f.assertIsolated();
  } finally { await f.close(); }
}, 10_000);
