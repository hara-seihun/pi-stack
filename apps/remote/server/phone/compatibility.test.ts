import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Compatibility, compatibilityCredentials, compatibilitySignature, signedCompatibilityWebhook, signedTwilioUpgrade, compatibilityStream, type CompatibilityKind } from "./compatibility";
import { providerSelection, loadProvider, mediaInstructions, dial } from "./provider";

const sw = { SIGNALWIRE_SPACE_URL: "https://synthetic.signalwire.com", SIGNALWIRE_PROJECT_ID: "project-123", SIGNALWIRE_API_TOKEN: "synthetic-api-token", SIGNALWIRE_SIGNING_KEY: "synthetic-signing-key", SIGNALWIRE_FROM_NUMBER: "+15555550100" };
const tw = { TWILIO_ACCOUNT_SID: "AC" + "1".repeat(32), TWILIO_AUTH_TOKEN: "synthetic-twilio-auth-token", TWILIO_FROM_NUMBER: "+15555550200" };
function fixture(t: any, kind: CompatibilityKind) {
  const root = mkdtempSync(join(tmpdir(), "compatibility-provider-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "credential.json");
  writeFileSync(file, JSON.stringify(kind === "twilio" ? tw : sw), { mode: 0o600 });
  return { file, root, client: new Compatibility(kind, file) };
}

test("Compatibility signature matches the published Twilio HMAC-SHA1 canonical vector", () => {
  const url = "https://example.com/myapp.php?foo=1&bar=2";
  const params = new URLSearchParams({ CallSid: "CA1234567890ABCDE", Caller: "+14158675310", Digits: "1234", From: "+14158675310", To: "+18005551212" });
  const expected = "L/OH5YylLD5NRKLltdqwSvS0BnU=";
  assert.equal(compatibilitySignature("12345", url, params), expected);
  assert.equal(signedCompatibilityWebhook(expected, "12345", url, params), true);
  for (const header of [null, "", "invalid", "AAAAAAAAAAAAAAAAAAAAAAAAAAA=", `${expected}\n`]) assert.equal(signedCompatibilityWebhook(header, "12345", url, params), false);
  assert.equal(signedCompatibilityWebhook(expected, "other-key", url, params), false);
  assert.equal(signedCompatibilityWebhook(expected, "12345", url.replace("https:", "http:"), params), false);
  assert.equal(signedCompatibilityWebhook(expected, "12345", url.replace("foo=1", "foo=2"), params), false);
  params.set("To", "+18005559999");
  assert.equal(signedCompatibilityWebhook(expected, "12345", url, params), false);
});

test("signatures canonicalize form order and repeated values but retain decoded UTF-8 content", () => {
  const a = new URLSearchParams("z=first&a=%2B%C3%A9&z=second&z=first"), b = new URLSearchParams("z=second&z=first&a=%2B%C3%A9");
  assert.equal(compatibilitySignature("key", "https://example.test/events", a), compatibilitySignature("key", "https://example.test/events", b));
  b.set("a", " é");
  assert.notEqual(compatibilitySignature("key", "https://example.test/events", a), compatibilitySignature("key", "https://example.test/events", b));
});

test("Twilio upgrades accept signed canonical HTTPS/WSS forms, not invented bearer auth or host/path changes", () => {
  const url = "https://phone.example/twilio/media/call/nonce?x=1&y=2";
  for (const scheme of ["https:", "wss:"]) {
    const sig = compatibilitySignature(tw.TWILIO_AUTH_TOKEN, url.replace("https:", scheme), new URLSearchParams());
    assert.equal(signedTwilioUpgrade(sig, tw.TWILIO_AUTH_TOKEN, url), true);
    for (const changed of [url.replace("nonce", "different"), url.replace("call", "other-call"), url.replace("phone.example", "injected.example"), url.replace("x=1&y=2", "y=2&x=1"), url + "/"]) assert.equal(signedTwilioUpgrade(sig, tw.TWILIO_AUTH_TOKEN, changed), false);
    assert.equal(signedTwilioUpgrade(sig, "wrong-token", url), false);
  }
  assert.equal(signedTwilioUpgrade(null, tw.TWILIO_AUTH_TOKEN, url), false);
  assert.equal(signedTwilioUpgrade("Bearer private-token", tw.TWILIO_AUTH_TOKEN, url), false);
});

test("provider selection and account/credential origins are explicit", t => {
  for (const pstnProvider of [undefined, "unknown", false, 1]) assert.equal(providerSelection({ pstnProvider }).ok, false);
  assert.deepEqual(providerSelection({ pstnProvider: null }), { ok: true, value: null });
  for (const kind of ["signalwire", "twilio"] as const) {
    const { file } = fixture(t, kind), config = { pstnProvider: kind, [`${kind}CredentialFile`]: file, publicBaseUrl: "https://phone.example" };
    assert.deepEqual(providerSelection(config), { ok: true, value: kind });
    assert.equal(providerSelection({ pstnProvider: kind, publicBaseUrl: "https://phone.example" }).ok, false);
    for (const base of ["http://phone.example", "https://user:secret@phone.example", "https://phone.example?key=1", "https://phone.example/#part"]) assert.equal(providerSelection({ ...config, publicBaseUrl: base }).ok, false);
    const p = loadProvider(kind, config); assert.ok(p.ok && p.value.kind === kind);
  }
  assert.equal(loadProvider("vonage", {}).ok, false);
  for (const space of ["https://evil.example", "https://signalwire.com.evil.example", "https://space.signalwire.com/path", "http://space.signalwire.com", "https://user:secret@space.signalwire.com", "https://space.signalwire.com?query=1"]) assert.equal(compatibilityCredentials("signalwire", { ...sw, SIGNALWIRE_SPACE_URL: space }).ok, false);
  for (const invalid of [{}, { ...sw, extra: "unknown" }, { ...sw, SIGNALWIRE_SIGNING_KEY: "" }, { ...sw, SIGNALWIRE_FROM_NUMBER: "5551234" }, { ...sw, SIGNALWIRE_PROJECT_ID: "../account" }]) assert.equal(compatibilityCredentials("signalwire", invalid).ok, false);
  for (const invalid of [{}, { ...tw, extra: "unknown" }, { ...tw, TWILIO_AUTH_TOKEN: "" }, { ...tw, TWILIO_FROM_NUMBER: "5551234" }, { ...tw, TWILIO_ACCOUNT_SID: "../account" }]) assert.equal(compatibilityCredentials("twilio", invalid).ok, false);
  assert.equal(compatibilityCredentials("twilio", sw).ok, false); assert.equal(compatibilityCredentials("signalwire", tw).ok, false);
});

test("deployment preflight rejects unset or unreadable providers without touching a running service", t => {
  const { file, root } = fixture(t, "twilio"), configFile = join(root, "phone.json");
  for (const [config, success] of [[{}, false], [{ pstnProvider: null }, true], [{ pstnProvider: "twilio", twilioCredentialFile: file, publicBaseUrl: "https://phone.example" }, true], [{ pstnProvider: "twilio", twilioCredentialFile: "/missing/credentials", publicBaseUrl: "https://phone.example" }, false]] as const) {
    writeFileSync(configFile, JSON.stringify(config));
    const result = spawnSync("bun", [new URL("./config-check.ts", import.meta.url).pathname, configFile], { encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, success ? 0 : 1); assert.ok(!result.stderr.includes(tw.TWILIO_AUTH_TOKEN));
  }
});

for (const kind of ["signalwire", "twilio"] as const) {
  test(`${kind} outbound form/auth/Stream transport dispatches once with provider-specific instructions`, async t => {
    const { client } = fixture(t, kind), requests: { url: string; options: RequestInit }[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => { requests.push({ url, options }); return Response.json({ sid: "synthetic-call", status: "queued" }); });
    const p = { kind, client, callerId: client.settings.callerId }, instruction = mediaInstructions(p, "https://phone.example", "private-media-token", "owned-call") as string;
    assert.match(instruction, /<Connect><Stream/);
    if (kind === "signalwire") { assert.match(instruction, /codec="PCMU@8000h"/); assert.match(instruction, /authBearerToken="private-media-token"/); assert.match(instruction, /realtime="true"/); }
    else { assert.match(instruction, /wss:\/\/phone\.example\/twilio\/media\/owned-call\/private-media-token/); assert.doesNotMatch(instruction, /authBearerToken|codec=|realtime=/); }
    const result = await dial(p, "+15555550123", "https://phone.example", "private-media-token", "owned-call"); assert.ok(result.ok && result.value.uuid === "synthetic-call");
    assert.equal(requests.length, 1);
    const expected = kind === "twilio" ? `https://api.twilio.com/2010-04-01/Accounts/${tw.TWILIO_ACCOUNT_SID}/Calls.json` : `${sw.SIGNALWIRE_SPACE_URL}/api/laml/2010-04-01/Accounts/project-123/Calls.json`;
    assert.equal(requests[0].url, expected);
    const headers = new Headers(requests[0].options.headers), identity = kind === "twilio" ? `${tw.TWILIO_ACCOUNT_SID}:${tw.TWILIO_AUTH_TOKEN}` : "project-123:synthetic-api-token";
    assert.equal(headers.get("authorization"), `Basic ${Buffer.from(identity).toString("base64")}`);
    assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(requests[0].options.body));
    assert.equal(body.get("To"), "+15555550123"); assert.equal(body.get("From"), client.settings.callerId);
    assert.equal(body.get(kind === "twilio" ? "Twiml" : "Laml"), instruction); assert.equal(body.get(kind === "twilio" ? "Laml" : "Twiml"), null);
    assert.equal(body.get("StatusCallback"), `https://phone.example/${kind}/events/owned-call`);
    assert.deepEqual(body.getAll("StatusCallbackEvent"), ["initiated", "ringing", "answered", "completed"]);
    assert.equal(body.get("StatusCallbackMethod"), "POST"); assert.equal(requests[0].options.redirect, "error");
    assert.ok(!String(body).includes(client.settings.signingKey));
    assert.match(compatibilityStream(kind, "wss://phone.example/a&b", 'quote"token'), /a&amp;b/);
  });

  test(`${kind} dial distinguishes definitive rejection from uncertainty and never retries either`, async t => {
    const { client } = fixture(t, kind); let calls = 0, mode: number | "network" | "missing-id" = 400;
    t.mock.method(globalThis, "fetch", async () => { calls++; if (mode === "network") throw new Error("private network details"); if (mode === "missing-id") return Response.json({ status: "queued" }); return new Response("private provider details", { status: mode }); });
    for (const [value, uncertain] of [[400, false], [401, false], [429, false], [500, true], [408, true], ["network", true], ["missing-id", true]] as const) {
      mode = value; const before = calls, r = await client.dial("+15555550123", "<Response />", "https://phone.example/events");
      assert.ok(!r.ok); if (!r.ok) { assert.equal(r.uncertain, uncertain); assert.ok(!r.error.includes("private")); } assert.equal(calls, before + 1);
    }
  });
}

test("hangup is complete only after accepted update or observed terminal state; Twilio cancels ringing calls", async t => {
  const { client } = fixture(t, "twilio"), requests: { method: string; status: string | null }[] = [];
  let state = "completed";
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
