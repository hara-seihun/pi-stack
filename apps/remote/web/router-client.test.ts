import { expect, test } from "bun:test";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

if (!process.env.PI_ROUTER_TEST_CASE) {
  test.each(["browser-root", "browser-prefix", "android-root", "android-prefix", "android-public"])("router transport and auth at %s", (scenario) => {
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
  let reportResolve: ((call: (typeof calls)[number]) => void) | undefined;
  const sessions = new Map<string, string>();
  let issued = 0;
  let wrongCloud = false;
  let healthFailure = true;
  let healthProbeGate: ((path: string) => Promise<void>) | null = null;
  let mutation: ((request: Request) => Promise<Response>) | null = null;
  let managerReply: ((request: Request) => Promise<Response>) | null = null;
  const synced: Array<{ user: string; session: string }> = [];
  const publicIngress = process.env.PI_ROUTER_TEST_CASE === "android-public";
  let accessVersion = 1;
  let rejectAccess = false;
  const bridge = {
    getState: async () => {
      if (rejectAccess) { rejectAccess = false; accessVersion++; }
      return { routerUrl: bootstrap, ...(publicIngress ? { accessToken: `cf-token-${accessVersion}` } : {}) };
    },
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
    const original = request.clone();
    const body = request.method === "POST" ? await request.json() : null;
    const call = { path, search: new URL(request.url).search, headers: request.headers, body };
    calls.push(call);
    if (path.endsWith("/v1/diagnostics/requests") && body.requests[0].state === "settled") reportResolve?.(call);
    if (new URL(request.url).origin !== "https://router.test") return json({ external: true });
    if (publicIngress) {
      expect(request.headers.get("cf-access-token")).toBe(`cf-token-${accessVersion}`);
      expect(request.credentials).toBe("include");
      expect(request.redirect).toBe("manual");
      if (rejectAccess) return json({ error: "Access token expired" }, 403);
    }
    if (path === "/v1/network") return json({ network: { name: "Household", loginServer: "https://mesh.test" }, connected: false });
    if (path === "/v1/app-update") return json({ release: { fileName: "current.apk" } });
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
    if (path.endsWith("/health")) {
      await healthProbeGate?.(path);
      if (healthFailure) { healthFailure = false; return json({ error: "Startup health unavailable" }, 503); }
      return json({ environmentId: path.startsWith("/v1/remotes/cloud/") && !wrongCloud ? "cloud" : "local" });
    }
    if (path === "/v1/environments") return json({ environments: [
      { id: "local", name: "Home", baseUrl: "", icon: "house" },
      ...(user === "sybil" ? [{ id: "cloud", name: "Cloud", baseUrl: "/v1/remotes/cloud", icon: "cloud" }] : []),
    ] });
    if (managerReply && path.endsWith("/v1/manager")) return managerReply(original);
    if (mutation && request.method === "POST" && /\/v1\/sessions(?:$|\/[^/]+\/prompt$)/.test(path)) return mutation(original);
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
    const network = await fetch("/v1/network");
    expect(await network.json()).toMatchObject({ connected: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/v1/network");
    expect(calls[0]!.headers.has("x-pi-remote-session")).toBe(false);
    expect(prompts).toBe(0);
    const rejected = await Promise.allSettled(Array.from({ length: 4 }, () => client.piFetch("/v1/stream", { method: "POST", body: "{}" })));
    expect(rejected.every(result => result.status === "rejected" && result.reason.message.includes("health returned HTTP 503"))).toBe(true);
    expect(calls.filter(call => call.path === "/v1/health")).toHaveLength(1);
    await Promise.all(Array.from({ length: 4 }, () => client.piFetch("/v1/stream", { method: "POST", body: "{}" })));
    expect(calls.filter(call => call.path === "/v1/health")).toHaveLength(2);
    expect(prompts).toBe(1);
    expect(calls.some(call => call.path === "/v1/auth/session")).toBe(!nativePlatform);
    const unlock = calls.findIndex(call => call.path === "/v1/unlock");
    const discovery = calls.findIndex(call => call.path === "/v1/environments");
    expect(discovery).toBeGreaterThan(unlock);
    expect(calls[unlock]!.headers.has("x-pi-remote-session")).toBe(false);
    expect(calls[discovery]!.headers.get("x-pi-remote-session")).toBe("token-1");
    wrongCloud = true;
    await expect(window.KenanRemote!.select({ id: "cloud", user: "sybil" })).rejects.toThrow("identity mismatch");
    const localEndpoint = await window.KenanRemote!.getState();
    expect(localEndpoint.id).toBe("local");
    {
      let began!: () => void;
      let release!: () => void;
      const probing = new Promise<void>(resolve => { began = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      healthProbeGate = async path => { if (path === "/v1/health") { began(); await gate; } };
      wrongCloud = false;
      window.dispatchEvent(new Event("pi-auth"));
      const stale = window.KenanRemote!.getState();
      await probing;
      await window.KenanRemote!.select({ id: "cloud", user: "sybil" });
      release();
      await expect(stale).rejects.toThrow("Endpoint selection superseded");
      expect((await window.KenanRemote!.getState()).id).toBe("cloud");
      healthProbeGate = null;
      await window.KenanRemote!.select({ id: "local", user: "sybil" });
      window.dispatchEvent(new Event("pi-auth"));
      let selectedBegan!: () => void;
      let selectedRelease!: () => void;
      const selecting = new Promise<void>(resolve => { selectedBegan = resolve; });
      const selectedGate = new Promise<void>(resolve => { selectedRelease = resolve; });
      const probesBefore = calls.filter(call => call.path.endsWith("/health")).length;
      healthProbeGate = async path => { if (path.startsWith("/v1/remotes/cloud/")) { selectedBegan(); await selectedGate; } };
      const explicit = window.KenanRemote!.select({ id: "cloud", user: "sybil" });
      await selecting;
      const concurrent = window.KenanRemote!.getState();
      selectedRelease();
      expect((await explicit).id).toBe("cloud");
      expect((await concurrent).id).toBe("cloud");
      expect(calls.filter(call => call.path.endsWith("/health"))).toHaveLength(probesBefore + 1);
      healthProbeGate = null;
      await window.KenanRemote!.select({ id: "local", user: "sybil" });
      wrongCloud = true;
    }
    wrongCloud = false;
    await window.KenanRemote!.select({ id: "cloud", user: "sybil" });
    const pinnedCalls = calls.length;
    await expect(native.pinnedFetch(localEndpoint, "sybil", "/v1/sessions/pinned/prompt", { method: "POST", body: "{}" })).rejects.toThrow("Request owner changed");
    expect(calls).toHaveLength(pinnedCalls);
    const cloudEndpoint = await window.KenanRemote!.getState();
    await expect(native.pinnedFetch(cloudEndpoint, "guest", "/v1/sessions/pinned/prompt", { method: "POST", body: "{}" })).rejects.toThrow("Request owner changed");
    expect(calls).toHaveLength(pinnedCalls);
    {
      const { requestManager } = await import("./src/manager-client");
      const { inFlight } = await import("./src/in-flight");
      const preference = { view: "mono", managerThreadId: "manager", hintSeen: true };
      for (const owner of ["local", "cloud"]) {
        let began!: () => void;
        let release!: (response: Response) => void;
        const sending = new Promise<void>(resolve => { began = resolve; });
        managerReply = async () => { began(); return new Promise<Response>(resolve => { release = resolve; }); };
        const saving = requestManager(owner, { view: "mono", hintSeen: true });
        await sending;
        expect(calls.at(-1)!.path).toBe(owner === "local" ? "/v1/manager" : "/v1/remotes/cloud/v1/manager");
        expect(calls.at(-1)!.headers.get("x-pi-remote-session")).toBe("token-1");
        expect(calls.at(-1)!.body).toEqual({ view: "mono", hintSeen: true });
        expect(inFlight.count()).toBe(1);
        expect(inFlight.list()[0]).toMatchObject({ method: "POST", path: "/v1/manager" });
        release(json(preference));
        expect(await saving).toEqual({ ok: true, value: preference });
        expect(inFlight.count()).toBe(0);
        expect((await window.KenanRemote!.getState()).id).toBe("cloud");
      }
      managerReply = async () => {
        expect(inFlight.count()).toBe(0);
        return json(preference);
      };
      expect(await requestManager("local")).toEqual({ ok: true, value: preference });
      managerReply = async () => { throw new TypeError("Manager owner unreachable"); };
      expect((await requestManager("local", { view: "mono" })).ok).toBe(false);
      expect(inFlight.count()).toBe(0);
      let began!: () => void;
      const sending = new Promise<void>(resolve => { began = resolve; });
      managerReply = async () => { began(); return new Promise<Response>(() => {}); };
      const controller = new AbortController();
      const cancelled = requestManager("local", { view: "mono" }, controller.signal);
      await sending;
      expect(inFlight.count()).toBe(1);
      controller.abort();
      expect(await cancelled).toMatchObject({ ok: false, error: { kind: "identity_changed" } });
      expect(inFlight.count()).toBe(0);
      const sent = calls.length;
      await expect(native.managerFetch("https://outside.example/v1/manager", { method: "POST" })).rejects.toThrow("not authorized");
      expect(calls).toHaveLength(sent);
      managerReply = null;
    }
    await native.pinnedFetch(cloudEndpoint, "sybil", "/v1/sessions/pinned/prompt", { method: "POST", body: JSON.stringify({ requestId: "retained" }) });
    expect(calls.at(-1)!.path).toBe("/v1/remotes/cloud/v1/sessions/pinned/prompt");
    expect(calls.at(-1)!.body).toEqual({ requestId: "retained" });
    expect(calls.at(-1)!.headers.get("x-pi-remote-session")).toBe("token-1");
    for (const creation of [true, false]) {
      const wire: Array<{ url: string; body: string; headers: [string, string][] }> = [];
      const body = creation ? { requestId: crypto.randomUUID(), sessionId: crypto.randomUUID(), destination: "home", model: null }
        : { requestId: crypto.randomUUID(), text: "Same message", delivery: "steer" };
      mutation = async request => {
        wire.push({ url: request.url, body: await request.clone().text(), headers: [...request.headers] });
        if (wire.length === 1) {
          if (creation) throw new TypeError("Controller listener was replaced");
          return json({ error: "Supervisor handing over" }, 503);
        }
        return creation ? json({ session: { id: body.sessionId } }, 201)
          : json({ accepted: true, workId: body.requestId, delivery: "steer" }, 202);
      };
      if (creation) expect(await client.api("POST", "/v1/sessions", body)).toMatchObject({ session: { id: body.sessionId } });
      else expect(await native.pinnedFetch(cloudEndpoint, "sybil", "/v1/sessions/pinned/prompt", { method: "POST", body: JSON.stringify(body) }).then(response => response.json()))
        .toMatchObject({ accepted: true, workId: body.requestId });
      expect(wire).toHaveLength(2);
      expect(wire[1]).toEqual(wire[0]);
      expect(wire[0].url).toContain("/v1/remotes/cloud/v1/sessions");
      expect(wire[0].body).toBe(JSON.stringify(body));
    }
    let staleCalls = 0;
    mutation = async () => {
      staleCalls++;
      await window.KenanRemote!.select({ id: "local", user: "sybil" });
      return json({ error: "Replacing" }, 503);
    };
    await expect(client.api("POST", "/v1/sessions", { requestId: crypto.randomUUID() })).rejects.toThrow("Request owner changed");
    expect(staleCalls).toBe(1);
    mutation = null;
    await window.KenanRemote!.select({ id: "cloud", user: "sybil" });
    const { beginRequest, inFlight, SLOW_REQUEST_MS } = await import("./src/in-flight");
    const diagnostic = new Promise<(typeof calls)[number]>(resolve => { reportResolve = resolve; });
    beginRequest("POST", "/v1/sessions/123?message=secret", performance.now() - SLOW_REQUEST_MS - 1)();
    const report = await diagnostic;
    expect(report.path).toBe("/v1/remotes/cloud/v1/diagnostics/requests");
    expect(report.headers.get("x-pi-remote-session")).toBe("token-1");
    const pendingReport = calls.find(call => call.path === report.path && call.body.requests[0].state === "pending");
    expect(pendingReport?.body.requests[0]).toMatchObject({ method: "POST", path: "/v1/sessions/123", state: "pending" });
    expect(report.body.requests[0]).toMatchObject({ id: pendingReport?.body.requests[0].id, state: "settled" });
    expect(report.body.requests[0].durationMs).toBeGreaterThanOrEqual(SLOW_REQUEST_MS);
    expect(report.body.clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(report.body.platform).toBe(nativePlatform ? "android" : "browser");
    expect(inFlight.count()).toBe(0);
    reportResolve = undefined;
    await client.piFetch("/v1/stream", { method: "POST", body: "{}" });
    expect(calls.at(-1)!.path).toBe("/v1/remotes/cloud/v1/stream");
    const download = window.KenanRemote!.resolveApiUrl("/v1/files?path=a");
    expect(download).toBe(`${bootstrap}/v1/remotes/cloud/v1/files?path=a&session=token-1`);
    expect(window.KenanRemote!.resolveApiUrl(download)).toBe(download);
    await fetch("/v1/environment");
    expect(calls.at(-1)!.path).toBe("/v1/remotes/cloud/v1/environment");
    expect(calls.at(-1)!.headers.get("x-pi-remote-session")).toBe("token-1");
    const networkCallCount = calls.length;
    await fetch("/v1/network");
    expect(calls).toHaveLength(networkCallCount + 1);
    expect(calls.at(-1)!.path).toBe("/v1/network");
    expect(calls.at(-1)!.headers.has("x-pi-remote-session")).toBe(false);
    await native.fetchPersonChooser();
    expect(calls.at(-1)!.path).toBe("/v1/environment");
    expect(calls.at(-1)!.headers.has("x-pi-remote-session")).toBe(false);
    await fetch("/v1/app-update");
    expect(calls.at(-1)!.path).toBe("/v1/app-update");
    expect(calls.at(-1)!.headers.has("x-pi-remote-session")).toBe(false);
    if (publicIngress) {
      rejectAccess = true;
      await fetch("/v1/app-update");
      expect(accessVersion).toBe(2);
      expect(window.PiRemotePerson.session()).toBe("token-1");
    }
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
    expect(calls.at(-1)!.headers.has("cf-access-token")).toBe(false);
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
    window.PiRemotePerson.set("sybil");
    peopleStorage.removeItem(`${!nativePlatform && prefix ? `${prefix}:` : ""}pi-remote-key:sybil`);
    sessions.clear();
    client.registerUnlockHandler(async () => { window.PiRemotePerson.set("guest"); return ""; });
    const beforeSettings = calls.filter(call => call.path.endsWith("/settings/person.autoCollapse")).length;
    await expect(client.api("PUT", "/v1/settings/person.autoCollapse", { value: false })).rejects.toThrow("selected person changed");
    expect(calls.filter(call => call.path.endsWith("/settings/person.autoCollapse"))).toHaveLength(beforeSettings + 1);
  } finally {
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as any)[name];
    }
  }
});
