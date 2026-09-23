import { describe, expect, test } from "bun:test";
import { admittedIdentity, OidcLogin, type OidcSettings } from "./oidc";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

const settings: OidcSettings = {
  issuer: "https://company.example/", clientId: "remote", clientSecret: "fixture",
  publicUrl: "https://work.example/pi-stack/", allowedEmailDomains: ["company.example"],
  subjectPrefix: "google-oauth2|", provisionCommand: ["/bin/false"],
};
const claims = { iss: settings.issuer, sub: "google-oauth2|123", email: "Person@Company.Example", email_verified: true, name: "Person" };

describe("OIDC identity admission", () => {
  test("binds the person to issuer and Google subject, not a chosen Unix account", () => {
    expect(admittedIdentity(settings, { ...claims, user: "kenan" })).toEqual({ ok: true, value: {
      version: 1, issuer: settings.issuer, subject: claims.sub, email: "person@company.example", emailVerified: true, displayName: "Person",
    } });
  });
  test.each([
    { email_verified: false }, { email_verified: "true" }, { sub: "auth0|123" },
    { iss: "https://attacker.example/" }, { email: "person@notcompany.example" },
    { email: "person@company.example.attacker.example" }, { email: "person@company.example@attacker.example" },
    { email: "person@gmail.com" }, { sub: undefined },
  ])("rejects a different identity boundary: %j", patch => {
    expect(admittedIdentity(settings, { ...claims, ...patch }).ok).toBe(false);
  });
});

test("OAuth state is browser-bound and missing transactions never reach provisioning", async () => {
  const login = new OidcLogin(settings);
  expect(login.callback.href).toBe("https://work.example/pi-stack/v1/auth/callback");
  expect(login.cookie(login.cookieName, "opaque", 60)).toContain("Path=/pi-stack/; HttpOnly; Secure; SameSite=Lax; Max-Age=60");
  expect(login.readCookie(new Request(settings.publicUrl, { headers: { cookie: `${login.cookieName}=a; ${login.cookieName}=b` } }))).toBeNull();
  expect((await login.finish(new Request(`${login.callback}?state=unknown&code=forged`))).ok).toBe(false);
  const admitted = admittedIdentity(settings, claims);
  if (!admitted.ok) throw new Error(admitted.error);
  expect((await login.provision(admitted.value)).ok).toBe(false);
});

test("code flow checks browser state, PKCE and ID-token nonce and consumes its transaction once", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const originalFetch = globalThis.fetch;
  let authorize: URL;
  let exchanges = 0;
  let wrongNonce = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/.well-known/openid-configuration")) return Response.json({
      issuer: settings.issuer, authorization_endpoint: `${settings.issuer}authorize`, token_endpoint: `${settings.issuer}token`,
      jwks_uri: `${settings.issuer}jwks`, response_types_supported: ["code"], subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"],
    });
    if (url.pathname === "/jwks") return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256", use: "sig" }] });
    if (url.pathname !== "/token") throw new Error(`Unexpected fixture request ${url}`);
    exchanges++;
    const params = new URLSearchParams(String(init?.body));
    expect(params.get("redirect_uri")).toBe("https://work.example/pi-stack/v1/auth/callback");
    expect(createHash("sha256").update(params.get("code_verifier")!).digest("base64url")).toBe(authorize.searchParams.get("code_challenge")!);
    const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encoded({ alg: "RS256", kid: "fixture" })}.${encoded({ ...claims, aud: settings.clientId,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
      nonce: wrongNonce ? "not-this-login" : authorize.searchParams.get("nonce") })}`;
    return Response.json({ access_token: "fixture-access", token_type: "Bearer", expires_in: 300,
      id_token: `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}` });
  }) as typeof fetch;
  try {
    const login = new OidcLogin(settings);
    const first = await login.begin();
    if (!first.ok) throw new Error(first.error);
    authorize = new URL(first.value.location);
    const callback = new URL(login.callback);
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    callback.searchParams.set("code", "fixture-code");
    const request = new Request(callback, { headers: { cookie: first.value.cookie.split(";")[0]! } });
    const completed = await login.finish(request);
    expect(completed.ok).toBe(true);
    expect(exchanges).toBe(1);
    expect((await login.finish(request)).ok).toBe(false);
    expect(exchanges).toBe(1);
    wrongNonce = true;
    const second = await login.begin();
    if (!second.ok) throw new Error(second.error);
    authorize = new URL(second.value.location);
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    expect((await login.finish(new Request(callback, { headers: { cookie: second.value.cookie.split(";")[0]! } }))).ok).toBe(false);
  } finally { globalThis.fetch = originalFetch; }
});
