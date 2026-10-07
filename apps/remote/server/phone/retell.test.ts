import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { callInstructions, type CallBrief } from "./policy.ts";
import { Retell, retellTerminal, type RetellCredentials } from "./retell.ts";

const credentials: RetellCredentials = { RETELL_API_KEY: "synthetic-retell-secret", RETELL_AGENT_ID: "agent_test", RETELL_AGENT_VERSION: 0, RETELL_FROM_NUMBER: "+442079460000" };
const brief: CallBrief = { to: "+442079460123", purpose: "Ask whether the shop is open", shareableFacts: ["Hara can arrive at noon"], opening: "Hello, I am Kenan, an AI assistant calling for Hara.", maxSeconds: 120 };
function fixture(t: TestContext, value: unknown = credentials) {
  const dir = mkdtempSync(join(tmpdir(), "pi-phone-retell-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "credentials.json");
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

test("Retell pins scoped agent/version, sends only the approved prompt and caps duration", async t => {
  const provider = new Retell(fixture(t));
  const requests: { url: string; options: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => { requests.push({ url, options }); return Response.json({ call_id: "call_test" }); });
  assert.equal(provider.settings.callerId, credentials.RETELL_FROM_NUMBER);
  assert.deepEqual(await provider.dial({ ...brief, maxSeconds: 1800 }, "local_test"), { ok: true, value: { uuid: "call_test" } });
  const request = requests[0];
  assert.equal(request.url, "https://api.retellai.com/v2/create-phone-call");
  assert.equal(request.options.method, "POST");
  assert.equal(new Headers(request.options.headers).get("authorization"), `Bearer ${credentials.RETELL_API_KEY}`);
  assert.equal(request.options.redirect, "error");
  assert.ok(request.options.signal);
  assert.deepEqual(JSON.parse(String(request.options.body)), {
    from_number: credentials.RETELL_FROM_NUMBER, to_number: brief.to,
    override_agent_id: "agent_test", override_agent_version: 0,
    metadata: { local_call_id: "local_test" },
    retell_llm_dynamic_variables: { approved_call_prompt: callInstructions(brief), approved_opening: brief.opening },
    agent_override: { agent: { max_call_duration_ms: 600_000 }, retell_llm: { start_speaker: "agent", begin_message: brief.opening, knowledge_base_ids: [] } },
  });
  assert.ok(!String(request.options.body).includes("Stay silent"));
  assert.ok(!String(request.options.body).includes(credentials.RETELL_API_KEY));
  assert.equal((await provider.dial({ ...brief, privateContext: "private-canary" } as CallBrief, "local_test")).ok, false);
  assert.equal((await provider.dial({ ...brief, maxSeconds: 30 }, "local_test")).ok, false);
  assert.equal(requests.length, 1);
  await provider.dial({ ...brief, maxSeconds: undefined }, "local_test");
  assert.equal(JSON.parse(String(requests[1].options.body)).agent_override.agent.max_call_duration_ms, 300_000);
});

test("Retell dial has no retries; uncertain acceptance and secret-safe rejection stay distinct", async t => {
  const provider = new Retell(fixture(t));
  let response: () => Promise<Response> = async () => Response.json({ call_id: "" });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return response(); });
  for (const run of [async () => Response.json({ call_id: "" }), async () => new Response("bad json"), async () => { throw new Error(credentials.RETELL_API_KEY); }, async () => Response.json({ detail: credentials.RETELL_API_KEY }, { status: 500 }), async () => new Response(null, { status: 408 })]) {
    response = run;
    const result = await provider.dial(brief, "local_test");
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.uncertain, true); assert.ok(!result.error.includes(credentials.RETELL_API_KEY)); }
  }
  assert.equal(requests, 5);
  response = async () => Response.json({ detail: credentials.RETELL_API_KEY }, { status: 401 });
  assert.deepEqual(await provider.dial(brief, "local_test"), { ok: false, error: "Retell HTTP 401: request failed", uncertain: false });
  assert.equal(requests, 6);
});

test("Retell GET validates identity/status and retains transcript, analysis, cost and end reason", async t => {
  const provider = new Retell(fixture(t));
  const cost = { product_costs: [{ product: "voice", unit_price: 1, cost: 60 }], total_duration_seconds: 60, total_duration_unit_price: 1, combined_cost: 60 };
  let value: unknown = { call_id: "call/with?reserved", call_status: "ended", transcript: "Agent: Approved opening", call_analysis: { call_summary: "Shop is open" }, call_cost: cost, duration_ms: 60_000, disconnection_reason: "agent_hangup", metadata: { ignored: true } };
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://api.retellai.com/v2/get-call/call%2Fwith%3Freserved");
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    return Response.json(value);
  });
  assert.deepEqual(await provider.get("call/with?reserved"), { ok: true, value: { uuid: "call/with?reserved", call_status: "ended", status: "completed", transcript: "Agent: Approved opening", call_analysis: { call_summary: "Shop is open" }, call_cost: cost, duration_ms: 60_000, disconnection_reason: "agent_hangup" } });
  for (const [call_status, status] of [["registered", "queued"], ["not_connected", "unanswered"], ["ongoing", "in-progress"], ["error", "failed"]]) {
    value = { call_id: "call/with?reserved", call_status };
    assert.deepEqual(await provider.get("call/with?reserved"), { ok: true, value: { uuid: "call/with?reserved", call_status, status } });
  }
  assert.equal(retellTerminal("unanswered"), true);
  assert.equal(retellTerminal("in-progress"), false);
  for (const invalid of [{ call_status: "future_status" }, { call_status: "__proto__" }, { call_id: "other" }, { duration_ms: -1 }, { transcript: {} }, { call_analysis: [] }, { call_cost: { combined_cost: 0 } }]) {
    value = { call_id: "call/with?reserved", call_status: "ended", ...invalid };
    assert.equal((await provider.get("call/with?reserved")).ok, false);
  }
});

test("Retell hangup uses stop-call and resolves an already terminal call without redial", async t => {
  const provider = new Retell(fixture(t));
  const requests: string[] = [];
  let stopOk = true;
  let status = "ended";
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    requests.push(url);
    if (url.includes("/stop-call/")) { assert.equal(options.method, "POST"); assert.equal(options.body, undefined); return new Response(null, { status: stopOk ? 204 : 400 }); }
    return Response.json({ call_id: "call_test", call_status: status });
  });
  assert.deepEqual(await provider.hangup("call_test"), { ok: true, value: { ended: true } });
  assert.deepEqual(requests, ["https://api.retellai.com/v2/stop-call/call_test"]);
  stopOk = false;
  assert.deepEqual(await provider.hangup("call_test"), { ok: true, value: { ended: true } });
  status = "ongoing";
  assert.deepEqual(await provider.hangup("call_test"), { ok: false, error: "Retell HTTP 400: request failed" });
  assert.equal((await provider.hangup("")).ok, false);
  assert.equal(requests.length, 5);
});

test("Retell credentials require private file permissions and an explicit version", t => {
  const path = fixture(t);
  chmodSync(path, 0o644);
  assert.throws(() => new Retell(path), /0600/);
  chmodSync(path, 0o600);
  const { RETELL_AGENT_VERSION: _, ...unversioned } = credentials;
  for (const invalid of [unversioned, { ...credentials, RETELL_AGENT_VERSION: "0" }, { ...credentials, RETELL_FROM_NUMBER: "442079460000" }, { ...credentials, RETELL_API_KEY: "bad\nkey" }]) {
    writeFileSync(path, JSON.stringify(invalid));
    assert.throws(() => new Retell(path), e => e instanceof Error && !e.message.includes(credentials.RETELL_API_KEY));
  }
});
