import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Twilio, twilioCredentials, twilioSignature, signedTwilioWebhook, signedTwilioUpgrade, twilioStream } from "./twilio";
import { providerSelection, loadProvider, mediaInstructions, dial } from "./provider";

const credentials = { TWILIO_ACCOUNT_SID: "AC" + "1".repeat(32), TWILIO_AUTH_TOKEN: "synthetic-twilio-auth-token", TWILIO_FROM_NUMBER: "+15555550200" };
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "twilio-provider-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "credential.json");
  writeFileSync(file, JSON.stringify(credentials), { mode: 0o600 });
  return { file, root, client: new Twilio(file) };
}

test("Twilio signed callbacks match published HMAC vector and bind exact external URL/form", () => {
  const url = "https://example.com/myapp.php?foo=1&bar=2";
  const params = new URLSearchParams({ CallSid: "CA1234567890ABCDE", Caller: "+14158675310", Digits: "1234", From: "+14158675310", To: "+18005551212" });
  const expected = "L/OH5YylLD5NRKLltdqwSvS0BnU=";
  assert.equal(twilioSignature("12345", url, params), expected);
  assert.equal(signedTwilioWebhook(expected, "12345", url, params), true);
  for (const header of [null, "", "invalid", "AAAAAAAAAAAAAAAAAAAAAAAAAAA=", `${expected}\n`]) assert.equal(signedTwilioWebhook(header, "12345", url, params), false);
  assert.equal(signedTwilioWebhook(expected, "other-key", url, params), false);
  for (const changed of [url.replace("https:", "http:"), url.replace("foo=1", "foo=2"), url.replace("example.com", "attacker.test")]) assert.equal(signedTwilioWebhook(expected, "12345", changed, params), false);
  params.set("To", "+18005559999");
  assert.equal(signedTwilioWebhook(expected, "12345", url, params), false);
  const a = new URLSearchParams("z=first&a=%2B%C3%A9&z=second&z=first"), b = new URLSearchParams("z=second&z=first&a=%2B%C3%A9");
  assert.equal(twilioSignature("key", url, a), twilioSignature("key", url, b));
  b.set("a", " é"); assert.notEqual(twilioSignature("key", url, a), twilioSignature("key", url, b));
});

test("signed Twilio upgrade binds canonical HTTPS/WSS URL including nonce and query order", () => {
  const url = "https://phone.example/twilio/media/call/nonce?x=1&y=2";
  for (const scheme of ["https:", "wss:"]) {
    const sig = twilioSignature(credentials.TWILIO_AUTH_TOKEN, url.replace("https:", scheme), new URLSearchParams());
    assert.equal(signedTwilioUpgrade(sig, credentials.TWILIO_AUTH_TOKEN, url), true);
    for (const changed of [url.replace("nonce", "different"), url.replace("call", "other-call"), url.replace("phone.example", "injected.example"), url.replace("x=1&y=2", "y=2&x=1"), url + "/"]) assert.equal(signedTwilioUpgrade(sig, credentials.TWILIO_AUTH_TOKEN, changed), false);
    assert.equal(signedTwilioUpgrade(sig, "wrong-token", url), false);
  }
  assert.equal(signedTwilioUpgrade(null, credentials.TWILIO_AUTH_TOKEN, url), false);
  assert.equal(signedTwilioUpgrade("Bearer private-token", credentials.TWILIO_AUTH_TOKEN, url), false);
});

test("calling selection, Twilio-only credentials and deployment preflight reject unset/invalid states", t => {
  const { file, root } = fixture(t), configFile = join(root, "phone.json");
  const enabled = { callingEnabled: true, pstnProvider: "twilio", twilioCredentialFile: file, publicBaseUrl: "https://phone.example" };
  for (const pstnProvider of [undefined, "unknown", "signalwire", "vonage", "retell", false, 1]) assert.equal(providerSelection({ ...enabled, pstnProvider }).ok, false);
  for (const callingEnabled of [undefined, null, "true", 1]) assert.equal(providerSelection({ ...enabled, callingEnabled }).ok, false);
  assert.equal(providerSelection({ callingEnabled: true, pstnProvider: null }).ok, false);
  assert.deepEqual(providerSelection({ callingEnabled: false, pstnProvider: null }), { ok: true, value: null });
  assert.deepEqual(providerSelection(enabled), { ok: true, value: "twilio" });
  assert.deepEqual(providerSelection({ ...enabled, callingEnabled: false }), { ok: true, value: "twilio" });
  assert.equal(loadProvider("twilio", enabled).ok, true);
  for (const base of [undefined, "http://phone.example", "https://user:secret@phone.example", "https://phone.example?key=1", "https://phone.example/#part"]) assert.equal(providerSelection({ ...enabled, publicBaseUrl: base }).ok, false);
  for (const twilioCredentialFile of [undefined, "relative.json", "/missing/credentials"]) assert.equal(loadProvider("twilio", { ...enabled, twilioCredentialFile }).ok, false);
  for (const invalid of [{}, { ...credentials, extra: "unknown" }, { ...credentials, TWILIO_AUTH_TOKEN: "" }, { ...credentials, TWILIO_FROM_NUMBER: "5551234" }, { ...credentials, TWILIO_ACCOUNT_SID: "../account" }]) assert.equal(twilioCredentials(invalid).ok, false);
  for (const [config, success] of [[{}, false], [{ callingEnabled: false, pstnProvider: null }, true], [enabled, true], [{ ...enabled, twilioCredentialFile: "/missing/credentials" }, false]] as const) {
    writeFileSync(configFile, JSON.stringify(config));
    const result = spawnSync("bun", [new URL("./config-check.ts", import.meta.url).pathname, configFile], { encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, success ? 0 : 1); assert.ok(!result.stderr.includes(credentials.TWILIO_AUTH_TOKEN));
  }
});

test("Twilio dispatches raw duplex Twiml once with provider-enforced maximum duration", async t => {
  const { client } = fixture(t), requests: { url: string; options: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => { requests.push({ url, options }); return Response.json({ sid: "synthetic-call", status: "queued" }); });
  const provider = { kind: "twilio" as const, client, callerId: client.settings.callerId };
  const instruction = mediaInstructions(provider, "https://phone.example", "private-media-token", "owned-call");
  assert.match(instruction, /<Connect><Stream url="wss:\/\/phone\.example\/twilio\/media\/owned-call\/private-media-token"/);
  assert.doesNotMatch(instruction, /authBearerToken|codec=|realtime=/);
  const result = await dial(provider, "+15555550123", "https://phone.example", "private-media-token", "owned-call", 60);
  assert.ok(result.ok && result.value.uuid === "synthetic-call"); assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://api.twilio.com/2010-04-01/Accounts/${credentials.TWILIO_ACCOUNT_SID}/Calls.json`);
  const headers = new Headers(requests[0].options.headers);
  assert.equal(headers.get("authorization"), `Basic ${Buffer.from(`${credentials.TWILIO_ACCOUNT_SID}:${credentials.TWILIO_AUTH_TOKEN}`).toString("base64")}`);
  assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
  const body = new URLSearchParams(String(requests[0].options.body));
  assert.equal(body.get("To"), "+15555550123"); assert.equal(body.get("From"), client.settings.callerId);
  assert.equal(body.get("Twiml"), instruction); assert.equal(body.get("Laml"), null);
  assert.equal(body.get("StatusCallback"), "https://phone.example/twilio/events/owned-call");
  assert.deepEqual(body.getAll("StatusCallbackEvent"), ["initiated", "ringing", "answered", "completed"]);
  assert.equal(body.get("TimeLimit"), "60"); assert.equal(body.get("Timeout"), "30");
  assert.equal(body.get("StatusCallbackMethod"), "POST"); assert.equal(requests[0].options.redirect, "error");
  assert.ok(!String(body).includes(client.settings.signingKey));
  assert.match(twilioStream("wss://phone.example/a&b"), /a&amp;b/);
  for (const duration of [undefined, 0, 29, 1801, 30.5, NaN] as any[]) assert.equal((await client.dial("+15555550123", instruction, "https://phone.example/events", duration)).ok, false);
  assert.equal(requests.length, 1);
});

test("uncertain or rejected create is never retried; hangup reconciles observed terminal/ringing state", async t => {
  const { client } = fixture(t); let calls = 0, mode: number | "network" | "missing-id" = 400;
  t.mock.method(globalThis, "fetch", async () => { calls++; if (mode === "network") throw new Error("private network details"); if (mode === "missing-id") return Response.json({ status: "queued" }); return new Response("private provider details", { status: mode }); });
  for (const [value, uncertain] of [[400, false], [401, false], [429, false], [500, true], [408, true], ["network", true], ["missing-id", true]] as const) {
    mode = value; const before = calls, r = await client.dial("+15555550123", "<Response />", "https://phone.example/events", 60);
    assert.ok(!r.ok); if (!r.ok) { assert.equal(r.uncertain, uncertain); assert.ok(!r.error.includes("private")); } assert.equal(calls, before + 1);
  }
  t.mock.restoreAll();
  const requests: { method: string; status: string | null }[] = []; let state = "completed";
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.match(url, /Calls\/call%2Fwith%3Freserved\.json$/);
    const status = new URLSearchParams(String(options.body ?? "")).get("Status"); requests.push({ method: options.method!, status });
    if (options.method === "POST") return status === "canceled" ? Response.json({ status: "canceled" }) : new Response("", { status: 409 });
    return Response.json({ status: state });
  });
  assert.equal((await client.hangup("call/with?reserved")).ok, true);
  assert.deepEqual(requests, [{ method: "POST", status: "completed" }, { method: "GET", status: null }]);
  state = "in-progress"; assert.equal((await client.hangup("call/with?reserved")).ok, false);
  state = "ringing"; requests.length = 0; assert.equal((await client.hangup("call/with?reserved")).ok, true);
  assert.deepEqual(requests, [{ method: "POST", status: "completed" }, { method: "GET", status: null }, { method: "POST", status: "canceled" }]);
});
