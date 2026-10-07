import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

const root = mkdtempSync(join(tmpdir(), "pi-remote-router-test-"));
const persons = join(root, "persons");
const bin = join(root, "bin");
const units = join(root, "units");
const keys = join(root, "keys");
const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = portProbe.port;
portProbe.stop(true);
const base = `http://127.0.0.1:${port}`;
let router: ReturnType<typeof Bun.spawn>;
const supervisors: ReturnType<typeof Bun.serve>[] = [];
let remoteCalls = 0;
const healthChecks = new Map<string, () => Promise<Response>>();
type UpstreamSocketData = { id: number; user: string; path: string };
type UpstreamConnection = UpstreamSocketData & { socket: Bun.ServerWebSocket<UpstreamSocketData> };
const websocketConnections: UpstreamConnection[] = [];
const websocketCloses: Array<UpstreamSocketData & { code: number }> = [];
let nextWebsocketId = 1;

function person(user: string, encrypted: boolean, remoteAccess: string[]) {
  const server = Bun.serve<UpstreamSocketData>({ hostname: "127.0.0.1", port: 0, fetch(req, httpServer) {
    if (!existsSync(join(units, `pi-remote@${user}.service`))) return new Response("Stopped", { status: 503 });
    const url = new URL(req.url);
    if (url.pathname === "/v1/health" && healthChecks.has(user)) return healthChecks.get(user)!();
    if (url.pathname === "/v1/immutable-test") return new Response(req.headers.has("if-none-match") ? null : user, { status: req.headers.has("if-none-match") ? 304 : 200, headers: { "cache-control": "private, max-age=31536000, immutable", etag: '"file"' } });
    if (url.pathname === "/v1/encoded-test") return new Response(gzipSync(JSON.stringify({ user, text: "message".repeat(500) })), { headers: { "content-type": "application/json", "content-encoding": "gzip", "cache-control": "private, no-cache" } });
    if (url.pathname === "/v1/cache-test") return req.headers.get("if-none-match") === 'W/"cache"'
      ? new Response(null, { status: 304, headers: { etag: 'W/"cache"', "cache-control": "private, no-cache" } })
      : Response.json({ user }, { headers: { etag: 'W/"cache"', "cache-control": "private, no-cache" } });
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket" && url.pathname.startsWith("/v1/ws-test/")) {
      if (req.headers.get("x-pi-remote-user") !== user) return new Response("Wrong person", { status: 403 });
      return httpServer.upgrade(req, { data: { id: nextWebsocketId++, user, path: url.pathname } })
        ? undefined
        : new Response("Upgrade failed", { status: 400 });
    }
    return Response.json({ user, path: url.pathname });
  }, websocket: {
    perMessageDeflate: false,
    open(socket) { websocketConnections.push({ ...socket.data, socket }); },
    message(socket, message) {
      if (socket.data.path === "/v1/ws-test/echo" && typeof message !== "string") socket.sendBinary(new Uint8Array([4, 5, 6]));
    },
    close(socket, code) { websocketCloses.push({ ...socket.data, code }); },
  } });
  supervisors.push(server);
  writeFileSync(join(persons, `${user}.json`), JSON.stringify({
    version: 1, user, displayName: user.toUpperCase(), port: server.port, remoteAccess,
    ...(encrypted ? { unlock: { cipherDir: `/home/${user}/.x.crypt`, mountpoint: `/home/${user}/x` } } : {}),
    environment: { PI_REMOTE_ENVIRONMENT_ID: "desk", PI_REMOTE_ENVIRONMENT_NAME: "Desk" },
  }));
}

beforeAll(async () => {
  for (const directory of [persons, bin, units, keys]) mkdirSync(directory, { recursive: true });
  const remote = Bun.serve<{ user: string; upstream: string; session: string | null }>({ hostname: "127.0.0.1", port: 0, fetch(req, httpServer) {
    remoteCalls++;
    const url = new URL(req.url);
    if (url.pathname === "/v1/phones/connect" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const upstream = req.headers.get("x-pi-remote-upstream");
      if (!upstream || upstream !== readFileSync(join(root, "upstream-credentials", "lab"), "utf8")) return new Response("Missing router proof", { status: 403 });
      return httpServer.upgrade(req, { data: { user: req.headers.get("x-pi-remote-user")!, upstream, session: req.headers.get("x-pi-remote-session") } }) ? undefined : new Response("Upgrade failed", { status: 400 });
    }
    if (url.pathname === "/v1/redirect") return Response.redirect("https://example.org");
    return Response.json({ path: url.pathname, query: url.search, user: req.headers.get("x-pi-remote-user"), session: req.headers.get("x-pi-remote-session"), authorization: req.headers.get("authorization"), cookie: req.headers.get("cookie"), accessToken: req.headers.get("cf-access-token"), accessAssertion: req.headers.get("cf-access-jwt-assertion"), referer: req.headers.get("referer"), upstream: req.headers.get("x-pi-remote-upstream") });
  }, websocket: { maxPayloadLength: 16 * 1024 * 1024, message(socket, message) { socket.send(JSON.stringify({ ...socket.data, bytes: typeof message === "string" ? message.length : message.byteLength, payload: "x".repeat(2 * 1024 * 1024) })); } } });
  supervisors.push(remote);
  writeFileSync(join(root, "host.json"), JSON.stringify({ environments: [
    { id: "desk", name: "Desk", icon: "home" },
    { id: "lab", name: "Laboratory", icon: "cloud", upstreams: { kenan: `http://127.0.0.1:${remote.port}` } },
  ] }));
  person("kenan", true, ["desk", "lab"]);
  person("sybil", true, ["desk"]);
  person("jodie", true, ["desk"]);
  person("guest", false, ["desk"]);
  writeFileSync(join(bin, "systemctl"), `#!/usr/bin/env bash
units=${JSON.stringify(units)}
keys=${JSON.stringify(keys)}
case "$1" in
  start)
    user=\${2#pi-remote@}; user=\${user%.service}
    if [[ $user != guest && $(<"$keys/$user") != "$user-key" ]]; then exit 1; fi
    touch "$units/$2" ;;
  stop) rm -f "$units/$2" ;;
  reset-failed) exit 0 ;;
  show) unit=\${@: -1}; if [[ -e $units/$unit ]]; then echo active; else echo inactive; fi ;;
  *) exit 1 ;;
esac
`);
  chmodSync(join(bin, "systemctl"), 0o755);
  await startRouter();
});

async function startRouter(oidcConfig = "") {
  router = Bun.spawn([process.execPath, join(import.meta.dir, "router.ts")], {
    stdout: "ignore", stderr: "pipe",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, PI_REMOTE_ROUTER_PORT: String(port), PI_REMOTE_PERSONS_DIR: persons, PI_STACK_HOST_FILE: join(root, "host.json"), PI_REMOTE_KEY_DIR: keys, PI_REMOTE_UPSTREAM_CREDENTIAL_DIR: join(root, "upstream-credentials"), PI_REMOTE_UNLOCK_TIMEOUT_MS: "300", PI_REMOTE_OIDC_CONFIG: oidcConfig },
  });
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/v1/router-health`)).ok) return; } catch {}
    await Bun.sleep(20);
  }
  router.kill();
  throw new Error(`router did not start: ${await new Response(router.stderr as ReadableStream).text()}`);
}
afterAll(async () => {
  router?.kill();
  await router?.exited;
  for (const server of supervisors) server.stop(true);
  rmSync(root, { recursive: true, force: true });
});
const request = (path: string, session?: string, user?: string) => fetch(`${base}${path}`, { headers: { ...(session ? { "x-pi-remote-session": session } : {}), ...(user ? { "x-pi-remote-user": user } : {}) } });
async function unlock(user: string, key = `${user}-key`) {
  return fetch(`${base}/v1/unlock`, { method: "POST", headers: { "x-pi-remote-user": user, "content-type": "application/json" }, body: JSON.stringify({ key }) });
}
async function token(user: string) {
  const response = await unlock(user, user === "guest" ? "" : `${user}-key`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.user).toBe(user);
  expect(body.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return body.session as string;
}

async function waitFor<T>(read: () => T | undefined, message: string): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(5);
  }
  throw new Error(message);
}

function openWebSocket(path: string, headers?: Record<string, string>): Promise<WebSocket> {
  const Client = WebSocket as typeof WebSocket & { new(url: string, options: Bun.WebSocketOptions): WebSocket };
  const socket = headers ? new Client(`ws://127.0.0.1:${port}${path}`, { headers }) : new WebSocket(`ws://127.0.0.1:${port}${path}`);
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error(`WebSocket failed to open: ${path}`)), { once: true });
  });
}

async function expectWebSocketRefused(path: string): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`WebSocket did not refuse: ${path}`)), 1_000);
    socket.addEventListener("open", () => { clearTimeout(timeout); reject(new Error(`WebSocket opened: ${path}`)); }, { once: true });
    const refused = () => { clearTimeout(timeout); resolve(); };
    socket.addEventListener("error", refused, { once: true });
    socket.addEventListener("close", refused, { once: true });
  });
}

test("router preserves upstream revalidation and partitions the browser cache by person and session", async () => {
  const kenan = await token("kenan");
  const first = await request("/v1/cache-test", kenan, "kenan");
  expect(first.headers.get("cache-control")).toBe("private, no-cache");
  expect(first.headers.get("vary")).toContain("X-Pi-Remote-User");
  expect(first.headers.get("vary")).toContain("X-Pi-Remote-Session");
  expect(first.headers.get("vary")).toContain("Cookie");
  const revalidated = await fetch(`${base}/v1/cache-test`, { headers: { "x-pi-remote-user": "kenan", "x-pi-remote-session": kenan, "if-none-match": first.headers.get("etag")! } });
  expect(revalidated.status).toBe(304);
  expect(revalidated.headers.get("cache-control")).toBe("private, no-cache");
  const encoded = await fetch(`${base}/v1/encoded-test`, { headers: { "x-pi-remote-user": "kenan", "x-pi-remote-session": kenan, "accept-encoding": "gzip" }, decompress: false } as RequestInit & { decompress: boolean });
  expect(encoded.headers.get("content-encoding")).toBe("gzip");
  expect(JSON.parse(gunzipSync(Buffer.from(await encoded.arrayBuffer())).toString()).user).toBe("kenan");
  const sybil = await token("sybil");
  expect((await (await request("/v1/cache-test", sybil, "sybil")).json()).user).toBe("sybil");
});

test("bootstrap exposes persons, not endpoint access; Android can preflight session headers", async () => {
  const environment = await (await request("/v1/environment")).json();
  expect(environment.environment.persons.map((p: any) => p.user)).toEqual(["guest", "jodie", "kenan", "sybil"]);
  expect(environment.environment.requiresUnlock).toBe(true);
  expect((await request("/v1/environments")).status).toBe(423);
  expect((await request("/v1/environments", undefined, "kenan")).status).toBe(423);
  const preflight = await fetch(`${base}/v1/environment`, { method: "OPTIONS", headers: { origin: "http://localhost", "access-control-request-headers": "x-pi-remote-session" } });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-headers")).toContain("x-pi-remote-session");
});

test.each([
  { user: "jodie", active: false },
  { user: "sybil", active: true },
  { user: "guest", active: true },
])("unlock waits for supervisor readiness: %j", async ({ user, active }) => {
  const unit = join(units, `pi-remote@${user}.service`);
  if (active) {
    writeFileSync(unit, "");
    if (user !== "guest") writeFileSync(join(keys, user), `${user}-key`);
  }
  const probed = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<Response>();
  healthChecks.set(user, () => { probed.resolve(); return ready.promise; });
  let settled = false;
  const starting = unlock(user, user === "guest" ? "" : `${user}-key`).then(response => {
    settled = true;
    return response;
  });
  try {
    const first = await Promise.race([probed.promise.then(() => "probe"), starting.then(() => "unlock")]);
    expect(first).toBe("probe");
    expect(existsSync(unit)).toBe(true);
    expect(settled).toBe(false);
    ready.resolve(Response.json({ ok: true }));
    const response = await starting;
    expect(response.status).toBe(200);
    const { session } = await response.json();
    healthChecks.delete(user);
    for (const path of ["/v1/health", "/v1/environment", "/v1/sessions"]) {
      expect((await request(path, session, user)).status).toBe(200);
    }
  } finally {
    ready.resolve(new Response("Test ended", { status: 503 }));
    healthChecks.delete(user);
    await starting;
  }
});

test("an active supervisor that never becomes ready cannot mint a session", async () => {
  healthChecks.set("sybil", async () => new Response("Starting", { status: 503 }));
  try {
    const response = await unlock("sybil");
    expect(response.status).toBe(503);
    expect((await response.json()).session).toBeUndefined();
    expect(existsSync(join(keys, "sybil"))).toBe(true);
    expect(existsSync(join(units, "pi-remote@sybil.service"))).toBe(true);
  } finally { healthChecks.delete("sybil"); }
});

test("header and query changes never inherit an already-unlocked owner's identity", async () => {
  const owner = await token("kenan");
  const sybil = await token("sybil");
  const before = remoteCalls;
  for (const path of ["/v1/sessions", "/v1/remotes/lab/v1/sessions", "/v1/remotes/lab/v1/notifications", "/v1/remotes/lab/v1/sessions/thread/files?path=/tmp/file"]) {
    expect((await request(path, undefined, "kenan")).status).toBe(423);
    expect((await request(path, sybil, "kenan")).status).toBe(403);
  }
  expect((await request("/v1/remotes/lab/v1/sessions?user=kenan", sybil)).status).toBe(403);
  expect((await request("/v1/remotes/lab/v1/sessions", sybil, "sybil")).status).toBe(403);
  expect((await request("/v1/sessions?user=sybil", owner, "kenan")).status).toBe(403);
  expect((await unlock("kenan", "wrong-key-while-mounted")).status).toBe(403);
  expect(remoteCalls).toBe(before);
  expect((await request("/v1/sessions", owner, "kenan")).status).toBe(200);
});

test("file editing uses the existing person-bound router authorization for reads and saves", async () => {
  const sybil = await token("sybil");
  const before = remoteCalls;
  for (const method of ["GET", "PUT"]) {
    for (const prefix of ["", "/v1/remotes/lab"]) {
      const url = `${base}${prefix}/v1/files/edit?path=%2Ftmp%2Ffixture.md`;
      const init = method === "PUT" ? { method, body: JSON.stringify({ path: "/tmp/fixture.md", content: "attempt", revision: "a".repeat(64) }) } : { method };
      expect((await fetch(url, { ...init, headers: { "x-pi-remote-user": "kenan", "content-type": "application/json" } })).status).toBe(423);
      expect((await fetch(url, { ...init, headers: { "x-pi-remote-user": "kenan", "x-pi-remote-session": sybil, "content-type": "application/json" } })).status).toBe(403);
    }
  }
  expect(remoteCalls).toBe(before);
  const allowed = await fetch(`${base}/v1/files/edit`, { method: "PUT", headers: {
    "x-pi-remote-session": sybil, "content-type": "application/json",
  }, body: JSON.stringify({ path: "/tmp/fixture.md", content: "permitted", revision: "a".repeat(64) }) });
  expect(allowed.status).toBe(200);
  expect((await allowed.json()).user).toBe("sybil");
});

test("each person's discovery is policy controlled; open guests receive no remote authority", async () => {
  for (const user of ["kenan", "sybil", "jodie", "guest"]) {
    const response = await request("/v1/environments", await token(user), user);
    const body = await response.json();
    expect(body.environments.map((e: any) => e.id)).toEqual(user === "kenan" ? ["desk", "lab"] : ["desk"]);
    expect(JSON.stringify(body)).not.toContain("upstreams");
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");
  }
});

test("immutable bytes cache only under an authenticated session-scoped resource URL", async () => {
  const kenan = await token("kenan");
  const sybil = await token("sybil");
  const path = "/v1/immutable-test";
  expect((await request(path, kenan)).headers.get("cache-control")).toBe("private, no-cache");
  const owned = await request(`${path}?session=${kenan}`);
  expect(await owned.text()).toBe("kenan");
  expect(owned.headers.get("cache-control")).toContain("immutable");
  const unchanged = await fetch(`${base}${path}?session=${kenan}`, { headers: { "if-none-match": '"file"' } });
  expect(unchanged.status).toBe(304);
  expect(unchanged.headers.get("cache-control")).toContain("immutable");
  expect((await request(`${path}?session=${sybil}&user=kenan`)).status).toBe(403);
  expect((await request(`${path}?session=${kenan}&user=sybil`)).status).toBe(403);
  expect((await request(path)).headers.get("cache-control")).toBe("no-store");
});

test("remote requests, notifications and downloads share authorization without forwarding credentials", async () => {
  const owner = await token("kenan");
  for (const path of ["/v1/sessions", "/v1/notifications", "/v1/sessions/thread/files"]) {
    const response = await fetch(`${base}/v1/remotes/lab${path}?session=${owner}&user=kenan&path=%2Ftmp%2Fa`, { headers: { authorization: "Bearer private", cookie: "secret=value", "cf-access-token": "ingress-token", "cf-access-jwt-assertion": "ingress-assertion", referer: `${base}/v1/file?session=${owner}`, "x-pi-remote-upstream": "forged" } });
    expect(response.status).toBe(200);
    // The upstream supervisor learns the person from this router's own credential, never the browser's.
    const upstream = readFileSync(join(root, "upstream-credentials", "lab"), "utf8");
    expect(upstream).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(root, "upstream-credentials", "lab")).mode & 0o777).toBe(0o600);
    expect(await response.json()).toEqual({ path, query: "?path=%2Ftmp%2Fa", user: "kenan", session: null, authorization: null, cookie: null, accessToken: null, accessAssertion: null, referer: null, upstream });
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  }
  expect((await request("/v1/remotes/lab/v1/redirect", owner)).status).toBe(502);
  expect((await request("/v1/remotes/lab/v1/remotes/desk/v1/health", owner)).status).toBe(403);
  expect((await request("/v1/remotes/lab/v1/lock", owner)).status).toBe(403);
});

test("WebSocket proxy authorizes before upstream and moves bytes both ways", async () => {
  const session = await token("guest");
  const before = websocketConnections.length;
  const socket = await openWebSocket(`/v1/ws-test/echo?session=${session}`);
  socket.binaryType = "arraybuffer";
  const reply = new Promise<Uint8Array>((resolve) => socket.addEventListener("message", event => resolve(new Uint8Array(event.data)), { once: true }));
  socket.send(new Uint8Array([1, 2, 3]));
  expect([...await reply]).toEqual([4, 5, 6]);
  expect(websocketConnections.slice(before).map(connection => connection.user)).toEqual(["guest"]);
  socket.close();

  const opened = websocketConnections.length;
  await expectWebSocketRefused("/v1/ws-test/echo");
  await expectWebSocketRefused(`/v1/ws-test/echo?session=${session}&user=kenan`);
  await Bun.sleep(20);
  expect(websocketConnections.length).toBe(opened);
});

test("remote phone WebSocket carries router proof, strips session and forwards binary-sized frames", async () => {
  await expectWebSocketRefused("/v1/remotes/lab/v1/phones/connect?user=kenan");
  const session = await token("kenan");
  const socket = await openWebSocket("/v1/remotes/lab/v1/phones/connect", { "x-pi-remote-session": session, "x-pi-remote-user": "kenan", "x-pi-remote-upstream": "forged" });
  const received = new Promise<any>(resolve => socket.addEventListener("message", event => resolve(JSON.parse(event.data)), { once: true }));
  socket.send("x".repeat(2 * 1024 * 1024));
  const frame = await received;
  expect(frame.user).toBe("kenan"); expect(frame.session).toBeNull();
  expect(frame.upstream).toBe(readFileSync(join(root, "upstream-credentials", "lab"), "utf8"));
  expect(frame.bytes).toBe(2 * 1024 * 1024); expect(frame.payload.length).toBe(2 * 1024 * 1024);
  socket.close();
});

test("WebSocket proxy propagates close codes in both directions", async () => {
  const session = await token("guest");

  const browserStart = websocketConnections.length;
  const browser = await openWebSocket(`/v1/ws-test/close-from-browser?session=${session}`);
  const browserUpstream = await waitFor(() => websocketConnections[browserStart], "browser-close upstream did not open");
  browser.close(4010, "browser closed");
  const upstreamClose = await waitFor(() => websocketCloses.find(event => event.id === browserUpstream.id), "browser close did not reach upstream");
  expect(upstreamClose.code).toBe(4010);

  const upstreamStart = websocketConnections.length;
  const downstream = await openWebSocket(`/v1/ws-test/close-from-upstream?session=${session}`);
  const upstream = await waitFor(() => websocketConnections[upstreamStart], "upstream-close socket did not open");
  const downstreamClose = new Promise<CloseEvent>((resolve) => downstream.addEventListener("close", resolve, { once: true }));
  upstream.socket.close(4011, "upstream closed");
  expect((await downstreamClose).code).toBe(4011);
});

test("lock requires proof and revokes every session for that person only", async () => {
  const owner = await token("kenan");
  const second = await token("kenan");
  const sybil = await token("sybil");
  expect((await fetch(`${base}/v1/lock?user=kenan`, { method: "POST" })).status).toBe(423);
  expect((await fetch(`${base}/v1/lock`, { method: "POST", headers: { "x-pi-remote-session": owner } })).status).toBe(200);
  for (const session of [owner, second]) {
    expect((await request("/v1/environments", session, "kenan")).status).toBe(423);
    expect((await request("/v1/remotes/lab/v1/sessions", session, "kenan")).status).toBe(423);
  }
  expect(existsSync(join(keys, "kenan"))).toBe(false);
  expect((await request("/v1/sessions", sybil, "sybil")).status).toBe(200);
  expect((await unlock("kenan", "wrong-key")).status).toBe(400);
  expect(existsSync(join(keys, "kenan"))).toBe(false);
});


test("router restart invalidates tokens but reuses the existing folder identity proof", async () => {
  const owner = await token("kenan");
  router.kill();
  await router.exited;
  await startRouter();
  expect((await request("/v1/remotes/lab/v1/sessions", owner, "kenan")).status).toBe(423);
  expect((await unlock("kenan", "wrong-key-after-restart")).status).toBe(403);
  expect((await request("/v1/remotes/lab/v1/sessions", await token("kenan"), "kenan")).status).toBe(200);
});

test("OAuth host hides the chooser and rejects key/name/cookie spoofing before any provider request", async () => {
  router.kill();
  await router.exited;
  const config = join(root, "oidc.json");
  writeFileSync(config, JSON.stringify({
    issuer: "https://company.example/", clientId: "fixture", clientSecret: "fixture",
    publicUrl: "https://work.example/pi-stack/", allowedEmailDomains: ["company.example"],
    subjectPrefix: "google-oauth2|", provisionCommand: ["/bin/false"],
  }));
  await startRouter(config);
  const chooser = await (await request("/v1/environment", undefined, "stale-person")).json();
  expect(chooser.environment.persons).toEqual([]);
  expect(chooser.environment.authentication.type).toBe("oidc");
  for (const user of ["guest", "kenan", "sybil"]) expect((await unlock(user)).status).toBe(423);
  expect((await request("/v1/auth/session")).status).toBe(423);
  expect((await fetch(`${base}/v1/auth/session`, { headers: { origin: "https://attacker.example" } })).status).toBe(403);
  expect((await fetch(`${base}/v1/auth/session`, { headers: { cookie: "pi-oidc-forged=kenan" } })).status).toBe(423);
  const callback = await request("/v1/auth/callback?code=forged&state=unknown");
  expect(callback.status).toBe(403);
  expect(callback.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await request("/v1/sessions", undefined, "kenan")).status).toBe(423);
});
