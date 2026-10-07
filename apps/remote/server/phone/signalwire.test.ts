import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { SignalWire, signalWireCredentials, signalWireSignature, signedSignalWireWebhook, signalWireStream } from "./signalwire";
import { providerSelection, loadProvider, mediaInstructions, dial } from "./provider";

const credentials = { SIGNALWIRE_SPACE_URL: "https://synthetic.signalwire.com", SIGNALWIRE_PROJECT_ID: "project-123", SIGNALWIRE_API_TOKEN: "synthetic-api-token", SIGNALWIRE_SIGNING_KEY: "synthetic-signing-key", SIGNALWIRE_FROM_NUMBER: "+15555550100" };
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "signalwire-provider-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "credential.json");
  writeFileSync(file, JSON.stringify(credentials), { mode: 0o600 });
  return { file, client: new SignalWire(file) };
}

test("Compatibility signature matches the published Twilio HMAC-SHA1 canonical vector", () => {
  const url = "https://example.com/myapp.php?foo=1&bar=2";
  const params = new URLSearchParams({ CallSid: "CA1234567890ABCDE", Caller: "+14158675310", Digits: "1234", From: "+14158675310", To: "+18005551212" });
  const expected = "L/OH5YylLD5NRKLltdqwSvS0BnU=";
  assert.equal(signalWireSignature("12345", url, params), expected);
  assert.equal(signedSignalWireWebhook(expected, "12345", url, params), true);
  for (const header of [null, "", "invalid", "AAAAAAAAAAAAAAAAAAAAAAAAAAA=", `${expected}\n`]) assert.equal(signedSignalWireWebhook(header, "12345", url, params), false);
  assert.equal(signedSignalWireWebhook(expected, "other-key", url, params), false);
  assert.equal(signedSignalWireWebhook(expected, "12345", url.replace("https:", "http:"), params), false);
  assert.equal(signedSignalWireWebhook(expected, "12345", url.replace("foo=1", "foo=2"), params), false);
  params.set("To", "+18005559999");
  assert.equal(signedSignalWireWebhook(expected, "12345", url, params), false);
});

test("signatures canonicalize form order and repeated values but retain decoded UTF-8 content", () => {
  const a = new URLSearchParams("z=first&a=%2B%C3%A9&z=second&z=first");
  const b = new URLSearchParams("z=second&z=first&a=%2B%C3%A9");
  assert.equal(signalWireSignature("key", "https://example.test/events", a), signalWireSignature("key", "https://example.test/events", b));
  b.set("a", " é");
  assert.notEqual(signalWireSignature("key", "https://example.test/events", a), signalWireSignature("key", "https://example.test/events", b));
});

test("provider is explicit, and credentials cannot redirect authenticated requests or invent a caller", t => {
  const { file } = fixture(t);
  for (const pstnProvider of [undefined, "twilio", false, 1]) assert.equal(providerSelection({ pstnProvider }).ok, false);
  assert.deepEqual(providerSelection({ pstnProvider: null }), { ok: true, value: null });
  for (const kind of ["vonage", "signalwire"] as const) assert.equal(providerSelection({ pstnProvider: kind, publicBaseUrl: "https://phone.example" }).ok, false);
  assert.deepEqual(providerSelection({ pstnProvider: "signalwire", signalwireCredentialFile: file, publicBaseUrl: "https://phone.example" }), { ok: true, value: "signalwire" });
  for (const base of ["http://phone.example", "https://user:secret@phone.example", "https://phone.example?key=1", "https://phone.example/#part"]) assert.equal(providerSelection({ pstnProvider: "signalwire", signalwireCredentialFile: file, publicBaseUrl: base }).ok, false);
  for (const space of ["https://evil.example", "https://signalwire.com.evil.example", "https://space.signalwire.com/path", "http://space.signalwire.com", "https://user:secret@space.signalwire.com", "https://space.signalwire.com?query=1"]) assert.equal(signalWireCredentials({ ...credentials, SIGNALWIRE_SPACE_URL: space }).ok, false);
  for (const invalid of [{}, { ...credentials, extra: "unknown" }, { ...credentials, SIGNALWIRE_SIGNING_KEY: "" }, { ...credentials, SIGNALWIRE_FROM_NUMBER: "5551234" }, { ...credentials, SIGNALWIRE_PROJECT_ID: "../account" }]) assert.equal(signalWireCredentials(invalid).ok, false);
  assert.equal(loadProvider("vonage", {}).ok, false);
  const p = loadProvider("signalwire", { signalwireCredentialFile: file });
  assert.ok(p.ok && p.value.kind === "signalwire" && p.value.callerId === credentials.SIGNALWIRE_FROM_NUMBER);
});

test("deployment preflight rejects an unset or unreadable provider without touching a running service", t => {
  const { file } = fixture(t), configFile = join(file, "..", "phone.json");
  for (const [config, success] of [[{}, false], [{ pstnProvider: null }, true], [{ pstnProvider: "signalwire", signalwireCredentialFile: file, publicBaseUrl: "https://phone.example" }, true], [{ pstnProvider: "signalwire", signalwireCredentialFile: "/missing/credentials", publicBaseUrl: "https://phone.example" }, false]] as const) {
    writeFileSync(configFile, JSON.stringify(config));
    const result = spawnSync("bun", [new URL("./config-check.ts", import.meta.url).pathname, configFile], { encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, success ? 0 : 1);
    assert.ok(!result.stderr.includes(credentials.SIGNALWIRE_API_TOKEN));
    assert.ok(!result.stderr.includes(credentials.SIGNALWIRE_SIGNING_KEY));
  }
});

test("outbound call uses Compatibility form, scoped Basic auth, inline duplex PCMU cXML and single dispatch", async t => {
  const { client } = fixture(t);
  const requests: { url: string; options: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => { requests.push({ url, options }); return Response.json({ sid: "synthetic-call", status: "queued" }); });
  const p = { kind: "signalwire" as const, client, callerId: credentials.SIGNALWIRE_FROM_NUMBER };
  const instruction = mediaInstructions(p, "https://phone.example", "private-media-token", "owned-call") as string;
  assert.match(instruction, /<Connect><Stream/);
  assert.match(instruction, /codec="PCMU@8000h"/);
  assert.match(instruction, /authBearerToken="private-media-token"/);
  assert.match(instruction, /realtime="true"/);
  assert.equal(await dial(p, "+15555550123", "https://phone.example", "private-media-token", "owned-call", 60).then(r => r.ok && r.value.uuid), "synthetic-call");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${credentials.SIGNALWIRE_SPACE_URL}/api/laml/2010-04-01/Accounts/project-123/Calls.json`);
  const headers = new Headers(requests[0].options.headers);
  assert.equal(headers.get("authorization"), `Basic ${Buffer.from("project-123:synthetic-api-token").toString("base64")}`);
  assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
  const body = new URLSearchParams(String(requests[0].options.body));
  assert.equal(body.get("To"), "+15555550123");
  assert.equal(body.get("From"), credentials.SIGNALWIRE_FROM_NUMBER);
  assert.equal(body.get("Laml"), instruction);
  assert.equal(body.get("StatusCallback"), "https://phone.example/signalwire/events/owned-call");
  assert.deepEqual(body.getAll("StatusCallbackEvent"), ["initiated", "ringing", "answered", "completed"]);
  assert.equal(body.get("StatusCallbackMethod"), "POST");
  assert.ok(!String(body).includes(credentials.SIGNALWIRE_SIGNING_KEY));
  assert.equal(requests[0].options.redirect, "error");
  assert.match(signalWireStream("wss://phone.example/a&b", 'quote"token'), /a&amp;b.*quote&quot;token/);
});

test("dial distinguishes definitive rejection from uncertainty and never retries either", async t => {
  const { client } = fixture(t);
  let calls = 0, mode: number | "network" | "missing-id" = 400;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (mode === "network") throw new Error("private network details");
    if (mode === "missing-id") return Response.json({ status: "queued" });
    return new Response("private provider details", { status: mode });
  });
  for (const [value, uncertain] of [[400, false], [401, false], [429, false], [500, true], [408, true], ["network", true], ["missing-id", true]] as const) {
    mode = value; const before = calls;
    const r = await client.dial("+15555550123", "<Response />", "https://phone.example/events");
    assert.ok(!r.ok); if (!r.ok) { assert.equal(r.uncertain, uncertain); assert.ok(!r.error.includes("private")); }
    assert.equal(calls, before + 1);
  }
});

test("hangup is complete only after an accepted update or observed terminal provider state", async t => {
  const { client } = fixture(t);
  const methods: string[] = [];
  let state = "completed";
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.match(url, /Calls\/call%2Fwith%3Freserved\.json$/);
    methods.push(options.method!);
    if (options.method === "POST") { assert.equal(new URLSearchParams(String(options.body)).get("Status"), "completed"); return new Response("", { status: 409 }); }
    return Response.json({ status: state });
  });
  assert.equal((await client.hangup("call/with?reserved")).ok, true);
  assert.deepEqual(methods, ["POST", "GET"]);
  state = "in-progress";
  assert.equal((await client.hangup("call/with?reserved")).ok, false);
});
