import { test } from "node:test";
import { strict as assert } from "node:assert";
import { retellProviderError, RETELL_ERROR_LIMIT } from "./retell-error";

const key = 'synthetic-key-"\\private', token = "a".repeat(64);
const silent = `wss://phone.example/retell/silent/${token}`;
const secrets = [key, silent, token];
function noSecrets(value: unknown) {
  const output = JSON.stringify(value);
  for (const secret of [...secrets, "unknown-monitor-secret", "unknown-ice-secret", "unknown-bearer-secret"]) for (const form of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) assert.ok(!output.includes(form), "Provider diagnostics exposed a credential");
}

test("JSON rejection keeps typed provider message/code and scrubs nested credentials and escaped echoes", async () => {
  const result = await retellProviderError(Response.json({
    error: { code: "INVALID_DURATION", message: `max_call_duration_ms rejected; ${key}; ${silent}` },
    request: { authorization: "Bearer unknown-bearer-secret", accessToken: "unknown-monitor-secret", ice_servers: [{ credential: "unknown-ice-secret" }] },
    encoded: encodeURIComponent(key), bare: token,
  }, { status: 400 }), secrets);
  assert.equal(result.status, 400); assert.equal(result.code, "INVALID_DURATION");
  assert.match(result.message!, /max_call_duration_ms rejected/);
  assert.equal(result.body.state, "captured");
  if (result.body.state === "captured") {
    assert.equal(result.body.format, "json"); assert.equal(result.body.truncated, false);
    assert.equal(JSON.parse(result.body.text).request.accessToken, "[REDACTED]");
  }
  noSecrets(result);
});

test("text rejection retains readable explanation without bearer, credential or silent URL echoes", async () => {
  const result = await retellProviderError(new Response(`Agent version is unpublished. Authorization: Bearer unknown-bearer-secret; credential='unknown-ice-secret'; access_token=unknown-monitor-secret; url=${silent}; ${key}`, { status: 409 }), secrets);
  assert.match(result.message!, /^Agent version is unpublished/);
  assert.equal(result.code, null); assert.equal(result.body.state, "captured");
  if (result.body.state === "captured") assert.equal(result.body.format, "text");
  noSecrets(result);
});

test("malformed JSON and wrong-shaped JSON are explicit diagnostic formats, not network uncertainty", async () => {
  const result = await retellProviderError(new Response(`{"message":"invalid ${token}`, { status: 400, headers: { "content-type": "application/json" } }), secrets);
  assert.equal(result.message, null); assert.equal(result.code, null);
  assert.equal(result.body.state, "captured");
  if (result.body.state === "captured") assert.equal(result.body.format, "invalid-json");
  noSecrets(result);
  const escaped = await retellProviderError(new Response(`{"message":"invalid ${"\\u0061".repeat(64)}`, { status: 400, headers: { "content-type": "application/json" } }), secrets);
  noSecrets(escaped);
  if (escaped.body.state === "captured") { assert.ok(!escaped.body.text.includes("\\u0061")); assert.match(escaped.body.text, /REDACTED/); }
  for (const value of [null, [], 42, { message: [], code: {} }]) {
    const parsed = await retellProviderError(Response.json(value, { status: 400 }), secrets);
    assert.equal(parsed.message, null); assert.equal(parsed.code, null);
    assert.equal(parsed.body.state, "captured");
  }
});

test("oversized stream is cancelled without retaining a prefix that might split an echoed credential", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode("x".repeat(RETELL_ERROR_LIMIT - 10) + token.slice(0, 10)));
    controller.enqueue(new TextEncoder().encode(token.slice(10)));
  }, cancel() { cancelled = true; } });
  const result = await retellProviderError(new Response(body, { status: 400 }), secrets);
  assert.deepEqual(result.body, { state: "too-large" }); assert.equal(cancelled, true);
  assert.equal(result.message, null); assert.equal(result.code, null);
});

test("empty, unreadable and invalid UTF-8 responses retain the provider status and explicit body state", async () => {
  for (const [response, state] of [
    [new Response(null, { status: 400 }), "empty"],
    [new Response(new Uint8Array([0xff]), { status: 400 }), "invalid-encoding"],
    [new Response(new ReadableStream({ start(c) { c.error(new Error(key)); } }), { status: 400 }), "unavailable"],
  ] as const) {
    const result = await retellProviderError(response, secrets);
    assert.equal(result.status, 400); assert.deepEqual(result.body, { state }); noSecrets(result);
  }
});

test("captured diagnostics remain byte-bounded when sanitizing short sensitive fields expands JSON", async () => {
  const value = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`token_${i}`, "x"]));
  const result = await retellProviderError(Response.json(value, { status: 400 }), secrets);
  assert.equal(result.body.state, "captured");
  if (result.body.state === "captured") { assert.ok(Buffer.byteLength(result.body.text) <= RETELL_ERROR_LIMIT); assert.equal(result.body.truncated, true); }
});
