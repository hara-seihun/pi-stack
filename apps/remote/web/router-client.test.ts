import { expect, test } from "bun:test";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

if (!process.env.PI_ROUTER_TEST_CASE) {
  test.each(["browser-root", "browser-prefix", "android-root", "android-prefix"])("router transport and auth at %s", (scenario) => {
    const result = Bun.spawnSync([process.execPath, "test", import.meta.path], {
      env: { ...process.env, PI_ROUTER_TEST_CASE: scenario }, stdout: "pipe", stderr: "pipe",
    });
    expect({ exitCode: result.exitCode, error: result.exitCode ? result.stderr.toString() : "" }).toEqual({ exitCode: 0, error: "" });
  });
} else test("shared client unlocks at bootstrap, discovers by session, renews expired tokens, and drops another person's endpoints", async () => {
  const nativePlatform = process.env.PI_ROUTER_TEST_CASE!.startsWith("android");
  const prefix = process.env.PI_ROUTER_TEST_CASE!.endsWith("prefix") ? "/pi-stack" : "";
  const bootstrap = nativePlatform ? `https://router.test${prefix}` : prefix;
  const page = nativePlatform ? "https://localhost/" : `https://router.test${prefix}/`;
  const names = ["window", "location", "document", "localStorage", "sessionStorage", "fetch", "addEventListener", "removeEventListener", "dispatchEvent", "PiRemotePerson", "KenanRemote", "Capacitor"] as const;
  const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const events = new EventTarget();
  const peopleStorage = storage();
  const tabs = storage();
  const calls: Array<{ path: string; search: string; headers: Headers; body: any }> = [];
  const sessions = new Map<string, string>();
  let issued = 0;
  let wrongCloud = false;
  const synced: Array<{ user: string; session: string }> = [];
  const bridge = {
    getState: async () => ({ routerUrl: bootstrap }),
    syncSession: async (identity: { user: string; session: string }) => {
      if (Boolean(identity.user) !== Boolean(identity.session)) throw new Error("Native rejects incomplete identity");
      synced.push(identity);
    },
  };
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), page), init);
    const wire = new URL(request.url);
    if (wire.origin === "https://router.test") expect(wire.pathname.startsWith(`${prefix}/v1/`)).toBe(true);
    const path = wire.pathname.slice(wire.origin === "https://router.test" ? prefix.length : 0);
    const body = request.method === "POST" ? await request.json() : null;
    calls.push({ path, search: new URL(request.url).search, headers: request.headers, body });
    if (new URL(request.url).origin !== "https://router.test") return json({ external: true });
    if (path === "/v1/environment" && !request.headers.has("x-pi-remote-session")) return json({ persons: [{ user: "sybil", requiresUnlock: true }, { user: "guest", requiresUnlock: false }] });
    if (path === "/v1/auth/session") return json({ error: "Account sign-in is not configured" }, 404);
    const hint = request.headers.get("x-pi-remote-user");
    if (path === "/v1/unlock") {
      if (hint === "sybil" && body.key !== "sybil-key") return json({ error: "Wrong key" }, 403);
      const session = `token-${++issued}`;
      sessions.set(session, hint!);
      return json({ ok: true, user: hint, session });
    }
    const user = sessions.get(request.headers.get("x-pi-remote-session") || "");
    if (!user) return json({ locked: true, persons: [] }, 423);
    if (hint !== user) return json({ error: "Conflicting person" }, 403);
    if (path.endsWith("/health")) return json({ environmentId: path.startsWith("/v1/remotes/cloud/") && !wrongCloud ? "cloud" : "local" });
    if (path === "/v1/environments") return json({ environments: [
      { id: "local", name: "Home", baseUrl: "", icon: "house" },
      ...(user === "sybil" ? [{ id: "cloud", name: "Cloud", baseUrl: "/v1/remotes/cloud", icon: "cloud" }] : []),
    ] });
    return json({ ok: true, user });
  };
  try {
    Object.assign(globalThis, { window: globalThis, location: new URL(page), document: new EventTarget(), localStorage: peopleStorage, sessionStorage: tabs, fetch: fetcher,
      Capacitor: { isNativePlatform: () => nativePlatform, registerPlugin: () => bridge },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) });
    const client = await import("./src/client");
    const native = await import("./src/native");
    await native.nativeSessionReady();
    expect(synced).toEqual(nativePlatform ? [{ user: "", session: "" }] : []);
    let prompts = 0;
    client.registerUnlockHandler(async () => { prompts++; window.PiRemotePerson.set("sybil"); return "sybil-key"; });
    expect(calls).toHaveLength(0);
    await client.piFetch("/v1/stream", { method: "POST", body: "{}" });
    expect(prompts).toBe(1);
    expect(calls.some(call => call.path === "/v1/auth/session")).toBe(!nativePlatform);
    const unlock = calls.findIndex(call => call.path === "/v1/unlock");
    const discovery = calls.findIndex(call => call.path === "/v1/environments");
    expect(discovery).toBeGreaterThan(unlock);
    expect(calls[unlock]!.headers.has("x-pi-remote-session")).toBe(false);
    expect(calls[discovery]!.headers.get("x-pi-remote-session")).toBe("token-1");
    wrongCloud = true;
    await expect(window.KenanRemote!.select({ id: "cloud", user: "sybil" })).rejects.toThrow("identity mismatch");
    expect((await window.KenanRemote!.getState()).id).toBe("local");
    wrongCloud = false;
    await window.KenanRemote!.select({ id: "cloud", user: "sybil" });
    await client.piFetch("/v1/stream", { method: "POST", body: "{}" });
    expect(calls.at(-1)!.path).toBe("/v1/remotes/cloud/v1/stream");
    const download = window.KenanRemote!.resolveApiUrl("/v1/files?path=a");
    expect(download).toBe(`${bootstrap}/v1/remotes/cloud/v1/files?path=a&session=token-1`);
    expect(window.KenanRemote!.resolveApiUrl(download)).toBe(download);
    await fetch("/v1/environment");
    expect(calls.at(-1)!.path).toBe("/v1/remotes/cloud/v1/environment");
    expect(calls.at(-1)!.headers.get("x-pi-remote-session")).toBe("token-1");
    await native.fetchPersonChooser();
    expect(calls.at(-1)!.path).toBe("/v1/environment");
    expect(calls.at(-1)!.headers.has("x-pi-remote-session")).toBe(false);
    await fetch(`${bootstrap}/v1/lock-status`);
    expect(calls.at(-1)!.path).toBe("/v1/lock-status");
    sessions.clear();
    await client.piFetch(new Request(`${page}v1/sync`, { method: "POST", body: JSON.stringify({ probe: "replayed-body" }) }));
    expect(calls.filter(call => call.path.endsWith("/sync")).slice(-2).map(call => call.body)).toEqual([{ probe: "replayed-body" }, { probe: "replayed-body" }]);
    expect(window.PiRemotePerson.session()).toBe("token-2");
    await client.piFetch(download);
    expect(calls.at(-1)!.search).toBe("?path=a");
    expect(calls.at(-1)!.headers.get("x-pi-remote-session")).toBe("token-2");
    expect(prompts).toBe(1);
    expect(calls.filter(call => call.path.includes("/unlock")).every(call => call.path === "/v1/unlock")).toBe(true);
    await expect(fetch("/v1/stream", { headers: { "x-pi-remote-user": "owner" } })).rejects.toThrow("authenticated person");
    await fetch("https://outside.example/v1/files");
    expect(calls.at(-1)!.headers.has("x-pi-remote-session")).toBe(false);
    expect(calls.at(-1)!.headers.has("x-pi-remote-user")).toBe(false);
    expect(window.PiRemotePerson.href("https://outside.example/v1/files")).toBe("https://outside.example/v1/files");
    window.PiRemotePerson.set("guest");
    await native.nativeSessionReady();
    if (nativePlatform) expect(synced.at(-1)).toEqual({ user: "", session: "" });
    expect(window.PiRemotePerson.session()).toBe("");
    expect(tabs.getItem(`${!nativePlatform && prefix ? `${prefix}:` : ""}pi-remote-environment:sybil`)).toBeNull();
    const guest = await window.KenanRemote!.getState();
    expect(guest.environments.map((endpoint: { id: string }) => endpoint.id)).toEqual(["local"]);
    expect(calls.filter(call => call.path === "/v1/unlock").at(-1)!.body).toEqual({});
    await expect(window.KenanRemote!.select({ id: "cloud", user: "guest" })).rejects.toThrow("not allowed");
    expect(prompts).toBe(1);
    await native.nativeSessionReady();
    if (nativePlatform) expect(synced.at(-1)).toEqual({ user: "guest", session: window.PiRemotePerson.session() });
    window.PiRemotePerson.clearSession();
    await native.nativeSessionReady();
    if (nativePlatform) expect(synced.at(-1)).toEqual({ user: "", session: "" });
  } finally {
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as any)[name];
    }
  }
});
