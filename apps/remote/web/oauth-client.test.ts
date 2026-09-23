import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

if (!process.env.PI_OAUTH_CLIENT_CASE) {
  test.each(["root", "prefix", "root-signed-out", "prefix-signed-out"])("OAuth browser bootstrap at %s", scenario => {
    const result = Bun.spawnSync([process.execPath, "test", import.meta.path], {
      env: { ...process.env, PI_OAUTH_CLIENT_CASE: scenario }, stdout: "pipe", stderr: "pipe",
    });
    expect({ exitCode: result.exitCode, error: result.exitCode ? result.stderr.toString() : "" }).toEqual({ exitCode: 0, error: "" });
  });
} else test("cookie identity precedes saved keys, remains account-bound, and renews through bootstrap", async () => {
  const prefix = process.env.PI_OAUTH_CLIENT_CASE!.startsWith("prefix") ? "/pi-stack" : "";
  const page = `https://router.test${prefix}/`;
  const names = ["window", "location", "document", "localStorage", "sessionStorage", "fetch", "addEventListener", "removeEventListener", "dispatchEvent", "PiRemotePerson", "KenanRemote", "Capacitor"] as const;
  const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const events = new EventTarget();
  const local = storage(), tab = storage();
  const storagePrefix = prefix ? `${prefix}:` : "";
  local.setItem(`${storagePrefix}pi-remote-person`, "previous");
  local.setItem(`${storagePrefix}pi-remote-key:previous`, "saved-key");
  tab.setItem(`${storagePrefix}pi-remote-session:previous`, "stale-session");
  const calls: Request[] = [];
  const navigation: string[] = [];
  const initiallySignedOut = process.env.PI_OAUTH_CLIENT_CASE!.endsWith("signed-out");
  let cookieStatus = initiallySignedOut ? 423 : 200;
  let cookieSession: unknown = { ok: true, user: "employee", session: "oauth-session" };
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), page), init);
    calls.push(request);
    const pathname = new URL(request.url).pathname;
    expect(pathname.startsWith(`${prefix}/v1/`)).toBe(true);
    const path = pathname.slice(prefix.length);
    if (path === "/v1/environment" && init?.credentials === "omit") {
      expect(request.headers.has("x-pi-remote-session")).toBe(false);
      expect(request.headers.has("x-pi-remote-user")).toBe(false);
      return Response.json({ environment: { authentication: { type: "oidc", loginPath: "/v1/auth/login", label: "Sign in with company" }, persons: [] } });
    }
    if (path === "/v1/auth/session") {
      expect(init?.credentials).toBe("same-origin");
      expect(init?.redirect).toBe("error");
      expect(request.headers.has("x-pi-remote-session")).toBe(false);
      return Response.json(cookieSession, { status: cookieStatus });
    }
    expect(path).not.toBe("/v1/unlock");
    expect(request.headers.get("x-pi-remote-user")).toBe("employee");
    expect(request.headers.get("x-pi-remote-session")).toBe("oauth-session");
    if (path === "/v1/environments") return Response.json({ environments: [{ id: "company", name: "Company", baseUrl: "" }] });
    if (path === "/v1/health") return Response.json({ environmentId: "company" });
    return Response.json({ environment: { id: "company" } });
  };
  try {
    Object.assign(globalThis, { window: globalThis, location: Object.assign(new URL(page), { assign: (url: string) => navigation.push(url) }), document: new EventTarget(), localStorage: local, sessionStorage: tab, fetch: fetcher,
      Capacitor: { isNativePlatform: () => false }, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) });
    const client = await import("./src/client");
    const native = await import("./src/native");
    const { auth } = await import("./src/person");
    let keyPrompts = 0;
    const signInMessages: string[] = [];
    client.registerUnlockHandler(async () => { keyPrompts++; return "saved-key"; });
    client.registerSignInHandler(message => signInMessages.push(message));
    if (initiallySignedOut) {
      await expect(client.ensureUnlocked()).rejects.toThrow("Sign in to continue");
      expect(window.PiRemotePerson.session()).toBe("");
      expect(signInMessages).toEqual([""]);
      expect(calls.map(request => new URL(request.url).pathname)).toEqual([`${prefix}/v1/environment`, `${prefix}/v1/auth/session`]);
      cookieStatus = 200;
      signInMessages.length = 0;
    }
    await client.ensureUnlocked();
    expect(calls.slice(0, 2).map(request => new URL(request.url).pathname)).toEqual([`${prefix}/v1/environment`, `${prefix}/v1/auth/session`]);
    expect(window.PiRemotePerson.get()).toBe("employee");
    expect(window.PiRemotePerson.session()).toBe("oauth-session");
    expect(keyPrompts).toBe(0);
    expect(signInMessages).toHaveLength(0);
    expect((await window.KenanRemote!.getState()).id).toBe("company");
    expect(window.KenanRemote!.resolveApiUrl("/v1/files?path=report")).toBe(`${prefix}/v1/files?path=report&session=oauth-session`);
    await fetch("/v1/environment");
    expect(auth.authentication?.type).toBe("oidc");
    expect(() => window.PiRemotePerson.set("previous")).toThrow("signed-in account");
    const { SignInDialog } = await import("./src/SignInDialog");
    const html = renderToStaticMarkup(createElement(SignInDialog));
    expect(html).toContain("Sign in with company");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("<select");

    window.PiRemotePerson.clearSession();
    cookieStatus = 423;
    await expect(client.ensureUnlocked()).rejects.toThrow("Sign in to continue");
    expect(signInMessages.at(-1)).toBe("");
    await native.beginSignIn();
    expect(navigation).toEqual([`${prefix}/v1/auth/login`]);
    expect(window.PiRemotePerson.session()).toBe("");

    for (const status of [500, 404]) {
      cookieStatus = status;
      await expect(client.ensureUnlocked()).rejects.toThrow(`Sign-in session returned HTTP ${status}`);
      expect(signInMessages.at(-1)).toContain(String(status));
    }
    cookieStatus = 200;
    cookieSession = { ok: true, user: "employee" };
    await expect(client.ensureUnlocked()).rejects.toThrow("invalid sign-in session");
    cookieSession = { ok: true, user: "employee", session: "oauth-session" };
    await client.ensureUnlocked();
    expect(window.PiRemotePerson.session()).toBe("oauth-session");
    expect((await native.loadEnvironments()).map(endpoint => endpoint.id)).toEqual(["company"]);
    expect(keyPrompts).toBe(0);
    expect(calls.some(request => new URL(request.url).pathname.endsWith("/v1/unlock"))).toBe(false);
  } finally {
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as any)[name];
    }
  }
});
