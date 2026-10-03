import { webResponse } from "./files";
import { appUpdateResponse } from "./app-update";
import { unlink, writeFile, readFile, mkdir, chmod } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { listPersons, publicPerson, type Person } from "./persons";
import { configuredEnvironments, personEnvironments, publicEnvironments } from "./environments";
import { RouterSessions } from "./router-sessions";
import { rootDebugConfig, rootDebugResponse } from "./root-debug";
import { proxyFetch } from "./proxy-fetch";
import { proxyWebsocket, type ProxySocketData } from "./proxy-websocket";
import { preflight, withCors } from "./cors";
import { OidcLogin, readOidcSettings } from "./oidc";
import type { HostAuthentication } from "./protocol";
import { networkStatus, readPrivateNetwork } from "./private-network";
import { Rooms, ROOM_CUSTODIAN } from "./rooms";
import { oneKenanEnabled } from "kenan-memory/config";
import { oneKenanConfig, custodyAuthenticate, custodyStatus } from "./one-kenan";

const PORT = Number(process.env.PI_REMOTE_ROUTER_PORT ?? "8788");
const HOST = process.env.PI_REMOTE_ROUTER_HOST ?? "127.0.0.1";
const KEY_DIR = process.env.PI_REMOTE_KEY_DIR ?? "/run/pi-remote-keys";
const UPSTREAM_CREDENTIAL_DIR = process.env.PI_REMOTE_UPSTREAM_CREDENTIAL_DIR ?? "/var/lib/pi-remote/upstream-credentials";
/** pi-orchestrator's UPSTREAM_CREDENTIAL_HEADER; inbound copies are stripped with every other x-pi-remote- header. */
const UPSTREAM_CREDENTIAL_HEADER = "x-pi-remote-upstream";
const WEB_DIR = join(import.meta.dir, "../web/dist");
const UNLOCK_TIMEOUT_MS = Number(process.env.PI_REMOTE_UNLOCK_TIMEOUT_MS ?? "20000");
const VERSION = "2.0.0";

const PEOPLE = listPersons();
if (PEOPLE.length === 0) throw new Error("Pi Remote knows no persons; add one with `pi-remote person add`");
const environmentIds = new Set(PEOPLE.map((person) => String(person.environment.PI_REMOTE_ENVIRONMENT_ID ?? "local")));
if (environmentIds.size !== 1) throw new Error(`Persons disagree on the environment id: ${[...environmentIds].join(", ")}`);
const ENVIRONMENT_ID = [...environmentIds][0]!;
const ENVIRONMENT_NAME = String(PEOPLE[0]!.environment.PI_REMOTE_ENVIRONMENT_NAME ?? "Local");
if (!/^[a-z][a-z0-9-]{0,31}$/.test(ENVIRONMENT_ID)) throw new Error("PI_REMOTE_ENVIRONMENT_ID must be a stable lowercase identifier");
const environments = configuredEnvironments({ PI_REMOTE_ENVIRONMENT_ID: ENVIRONMENT_ID, PI_REMOTE_ENVIRONMENT_NAME: ENVIRONMENT_NAME });
const grants = new Map(PEOPLE.map((person) => [person.user, personEnvironments(person, environments, ENVIRONMENT_ID)]));
const byUser = new Map(PEOPLE.map((person) => [person.user, person]));
const oidcSettings = readOidcSettings();
const login = oidcSettings ? new OidcLogin(oidcSettings) : null;
const privateNetwork = readPrivateNetwork();
const sessions = new RouterSessions(login ? 8 * 60 * 60 * 1000 : undefined);
const activeUsers = new Set<string>();
const ONE_KENAN = oneKenanConfig();
const unit = (person: Person) => `pi-remote@${person.user}.service`;
const operations = new Map<string, Promise<unknown>>();
const rooms = oneKenanEnabled() ? new Rooms(process.env.PI_REMOTE_ROOMS_DB ?? "/var/lib/pi-remote/one-kenan/rooms.sqlite3",
  () => PEOPLE.map(({ user, displayName }) => ({ user, displayName })),
  async (owner, actor, path, method, body) => {
    const person = byUser.get(owner);
    const origin = owner === ROOM_CUSTODIAN ? process.env.PI_REMOTE_ROOMS_OWNER_URL ?? "http://127.0.0.1:18822" : person ? `http://127.0.0.1:${person.port}` : null;
    if (!origin) return Response.json({ error: "Room owner no longer registered" }, { status: 503 });
    const endpoint = new URL(origin);
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Room runtime must be a local loopback HTTP origin");
    return proxy({ port: person?.port ?? Number(endpoint.port), user: actor }, origin,
      new Request(`http://router${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }),
      new URL(`http://router${path}`), AbortSignal.timeout(10_000));
  }) : null;
if (rooms) setInterval(() => { void rooms.tick().catch(error => console.error("Room reconciliation failed", error)); }, 2_000);

async function serialized<T>(person: Person, operation: () => Promise<T>): Promise<T> {
  const previous = operations.get(person.user) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  operations.set(person.user, next);
  try { return await next; }
  finally { if (operations.get(person.user) === next) operations.delete(person.user); }
}

function assertedNames(req: Request, url: URL): string[] {
  return [req.headers.get("x-pi-remote-user"), ...url.searchParams.getAll("user")].filter((name): name is string => Boolean(name));
}

async function activeState(person: Person): Promise<string> {
  const proc = Bun.spawn(["systemctl", "show", "-p", "ActiveState", "--value", unit(person)], { stdout: "pipe", stderr: "ignore" });
  const [, state] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return state.trim();
}
const unitActive = async (person: Person) => (await activeState(person)) === "active";
async function routedActive(person: Person): Promise<boolean> {
  if (activeUsers.has(person.user)) return true;
  const active = await unitActive(person);
  if (active) activeUsers.add(person.user);
  return active;
}

async function systemctl(...args: string[]): Promise<{ ok: boolean; message: string }> {
  const proc = Bun.spawn(["systemctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { ok: code === 0, message: (err || out).trim() };
}

async function supervisorHealthy(person: Person): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${person.port}/v1/health`, { signal: AbortSignal.timeout(1_500) });
    if (response.ok) activeUsers.add(person.user);
    return response.ok;
  } catch { return false; }
}

async function waitForSupervisor(person: Person): Promise<boolean> {
  const deadline = Date.now() + UNLOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await supervisorHealthy(person)) return true;
    const state = await activeState(person);
    if (state === "failed" || state === "inactive") break;
    await Bun.sleep(200);
  }
  activeUsers.delete(person.user);
  return false;
}

type StartResult = { ok: true } | { ok: false; error: string; status: number };
async function start(person: Person, key: string): Promise<StartResult> {
  const personal = await startPersonal(person, key);
  if (personal.ok && ONE_KENAN && person.unlock) {
    void custodyAuthenticate(ONE_KENAN, person.user, key).then(captured => {
      if (!captured.ok) console.error(`Kenan custody capture for ${person.user} did not finish: ${captured.error}`);
    });
  }
  return personal;
}
async function startPersonal(person: Person, key: string): Promise<StartResult> {
  if (person.unlock && !key) return { ok: false, error: "Key required", status: 400 };
  if (await unitActive(person)) {
    if (person.unlock) {
      // A mounted folder proves the retained credential, not a new caller's key.
      const retained = await readFile(join(KEY_DIR, person.user)).catch(() => null);
      if (!retained) return { ok: false, error: "Active folder has no retained unlock credential; stop its unit before unlocking", status: 503 };
      const supplied = Buffer.from(key);
      if (retained.length !== supplied.length || !timingSafeEqual(retained, supplied)) return { ok: false, error: "Wrong key", status: 403 };
    }
    return await waitForSupervisor(person)
      ? { ok: true }
      : { ok: false, error: "The supervisor did not become ready", status: 503 };
  }
  await mkdir(KEY_DIR, { recursive: true, mode: 0o700 });
  await chmod(KEY_DIR, 0o700);
  await writeFile(join(KEY_DIR, person.user), key, { mode: 0o600 });
  try {
    const started = await systemctl("start", unit(person));
    if (!started.ok) {
      await forget(person);
      return { ok: false, error: "Wrong key, or the supervisor could not start", status: 400 };
    }
    if (await waitForSupervisor(person)) return { ok: true };
    await forget(person);
    return { ok: false, error: person.unlock ? "Wrong key, or the folder would not open" : "The supervisor did not come up", status: 400 };
  } catch {
    await forget(person);
    return { ok: false, error: "Could not start the supervisor", status: 500 };
  }
}

async function forget(person: Person): Promise<{ ok: boolean; message: string }> {
  sessions.revoke(person.user);
  activeUsers.delete(person.user);
  const stopped = await systemctl("stop", unit(person));
  await unlink(join(KEY_DIR, person.user)).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await systemctl("reset-failed", unit(person));
  return stopped;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authorization", "proxy-authenticate", "te", "trailer"]);

type RequestIdentity = {
  authenticated: { user: string; signal: AbortSignal } | null;
  asserted: string | undefined;
  person: Person | undefined;
  error?: Response;
};

type ProxyDestination = { origin: string; target: URL; upstream?: string } | { error: Response };

/**
 * The credential this router presents to an upstream environment's supervisor.
 * A supervisor treats loopback callers as local processes unless a front door
 * vouches for the person: its own router by running as root, an upstream
 * router by this secret, whose SHA-256 the upstream host lists in
 * host.json `upstreamCredentials`. Only root can read it here.
 */
const upstreamCredentials = new Map<string, string>();
function upstreamCredential(environment: string): string {
  const cached = upstreamCredentials.get(environment);
  if (cached) return cached;
  const path = join(UPSTREAM_CREDENTIAL_DIR, environment);
  mkdirSync(UPSTREAM_CREDENTIAL_DIR, { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(path, "wx", 0o600);
    try { writeSync(fd, randomBytes(32).toString("hex")); } finally { closeSync(fd); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const credential = readFileSync(path, "utf8").trim();
  upstreamCredentials.set(environment, credential);
  return credential;
}

function requestIdentity(req: Request, url: URL): RequestIdentity {
  const names = assertedNames(req, url);
  const tokens = [req.headers.get("x-pi-remote-session"), ...url.searchParams.getAll("session")].filter((token): token is string => Boolean(token));
  if (new Set(names).size > 1 || new Set(tokens).size > 1) {
    return { authenticated: null, asserted: undefined, person: undefined, error: Response.json({ error: "Conflicting identity" }, { status: 403 }) };
  }
  const authenticated = sessions.get(tokens[0] ?? null);
  if (authenticated && names.some((name) => name !== authenticated.user)) {
    return { authenticated, asserted: names[0], person: undefined, error: Response.json({ error: "Session belongs to another person" }, { status: 403 }) };
  }
  const asserted = names[0];
  const person = authenticated ? byUser.get(authenticated.user) : asserted ? byUser.get(asserted) : PEOPLE.length === 1 ? PEOPLE[0] : undefined;
  return { authenticated, asserted, person };
}

function proxyDestination(person: Person, url: URL): ProxyDestination {
  if (rooms && (url.pathname.startsWith("/v1/room-owner/") || /^\/v1\/remotes\/[^/]+\/v1\/(rooms|room-owner)(\/|$)/.test(url.pathname))) return { error: Response.json({ error: "Use this host's room directory" }, { status: 403 }) };
  if (url.pathname.startsWith("/v1/remotes/")) {
    const match = /^\/v1\/remotes\/([a-z][a-z0-9-]{0,31})(\/v1\/.*)$/.exec(url.pathname);
    if (!match) return { error: Response.json({ error: "Unknown remote route" }, { status: 404 }) };
    const endpoint = grants.get(person.user)!.find((candidate) => candidate.id === match[1]);
    if (!endpoint?.upstreams?.[person.user]) return { error: Response.json({ error: "Endpoint access denied" }, { status: 403 }) };
    if (/^\/v1\/(remotes|unlock|lock|lock-status|environments|router-health)(\/|$)/.test(match[2]!)) {
      return { error: Response.json({ error: "Use the identity router for this operation" }, { status: 403 }) };
    }
    const target = new URL(url);
    target.pathname = match[2]!;
    return { origin: endpoint.upstreams[person.user]!, target, upstream: match[1]! };
  }
  if (!url.pathname.startsWith("/v1/")) return { error: new Response("Not found", { status: 404 }) };
  return { origin: `http://127.0.0.1:${person.port}`, target: url };
}

function websocketUrl(origin: string, url: URL): string {
  const target = new URL(`${url.pathname}${url.search}`, origin);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  target.searchParams.delete("user");
  target.searchParams.delete("session");
  return target.href;
}

async function openUpstream(target: string, protocols: string[], user: string, signal: AbortSignal, environment?: string): Promise<WebSocket | null> {
  const WebSocketClient = WebSocket as typeof WebSocket & { new(url: string, options: Bun.WebSocketOptions): WebSocket };
  const upstream = new WebSocketClient(target, {
    protocols,
    headers: { "x-pi-remote-user": user, ...(environment ? { [UPSTREAM_CREDENTIAL_HEADER]: upstreamCredential(environment) } : {}) },
    perMessageDeflate: false,
  });
  upstream.binaryType = "arraybuffer";
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    function opened() { finish(upstream); }
    function failed() { finish(null); }
    function aborted() { finish(null); }
    function finish(result: WebSocket | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      upstream.removeEventListener("open", opened);
      upstream.removeEventListener("error", failed);
      upstream.removeEventListener("close", failed);
      signal.removeEventListener("abort", aborted);
      if (!result) (upstream as WebSocket & { terminate(): void }).terminate();
      resolve(result);
    }
    timeout = setTimeout(failed, 3_000);
    upstream.addEventListener("open", opened, { once: true });
    upstream.addEventListener("error", failed, { once: true });
    upstream.addEventListener("close", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

async function websocketRoute(req: Request, url: URL, server: Bun.Server<ProxySocketData>): Promise<Response | undefined> {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const identity = requestIdentity(req, url);
  if (identity.error) return identity.error;
  const { authenticated, asserted, person } = identity;
  if (asserted && !person) return Response.json({ error: "This machine does not know you. Ask to be added to Pi Remote.", persons }, { status: 403 });
  if (!authenticated || !person) return locked(person?.user);
  if (!(await routedActive(person))) {
    sessions.revoke(person.user);
    return locked(person.user);
  }
  const destination = proxyDestination(person, url);
  if ("error" in destination) return destination.error;
  if (authenticated.signal.aborted) return locked(person.user);
  const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map(value => value.trim()).filter(Boolean);
  const upstream = await openUpstream(websocketUrl(destination.origin, destination.target), protocols, person.user, authenticated.signal, destination.upstream);
  if (!upstream) return Response.json({ error: authenticated.signal.aborted ? "Session ended" : "Supervisor WebSocket unreachable" }, { status: authenticated.signal.aborted ? 423 : 502 });
  const upgraded = server.upgrade(req, {
    ...(upstream.protocol ? { headers: { "sec-websocket-protocol": upstream.protocol } } : {}),
    data: { phone: destination.target.pathname === "/v1/phones/connect", upstream, signal: authenticated.signal, closed: false },
  });
  if (!upgraded) upstream.close(1011, "Browser upgrade failed");
  return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
}

async function proxy(person: Pick<Person, "user" | "port">, origin: string, req: Request, url: URL, signal: AbortSignal, upstream?: string): Promise<Response> {
  const headers = new Headers(req.headers);
  for (const name of (headers.get("connection") ?? "").split(",")) if (name.trim()) headers.delete(name.trim());
  for (const name of [...headers.keys()]) {
    if (HOP_BY_HOP.has(name) || ["host", "cookie", "authorization", "forwarded", "referer", "cf-access-token", "cf-access-jwt-assertion", "cf-access-authenticated-user-email"].includes(name) || name.startsWith("x-forwarded-") || name.startsWith("x-pi-remote-")) headers.delete(name);
  }
  headers.set("x-pi-remote-user", person.user);
  if (upstream) headers.set(UPSTREAM_CREDENTIAL_HEADER, upstreamCredential(upstream));
  const query = new URLSearchParams(url.search);
  query.delete("user");
  query.delete("session");
  const target = `${origin}${url.pathname}${query.size ? `?${query}` : ""}`;
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : req.body;
  try {
    const response = await proxyFetch(target, { method: req.method, headers, body, signal: AbortSignal.any([req.signal, signal]), redirect: "manual", ...(body ? { duplex: "half" } : {}) } as RequestInit);
    // API upstreams cannot redirect a request carrying the client's credential.
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      await response.body?.cancel();
      return Response.json({ error: "Upstream API redirects are not supported" }, { status: 502 });
    }
    const out = new Headers(response.headers);
    for (const name of HOP_BY_HOP) out.delete(name);
    out.delete("set-cookie");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
  } catch {
    if (origin === `http://127.0.0.1:${person.port}`) activeUsers.delete(person.user);
    return Response.json({ error: signal.aborted ? "Session ended" : "Supervisor unreachable" }, { status: signal.aborted ? 423 : 502 });
  }
}

const persons = login ? [] : PEOPLE.filter(person => person.auth !== "oidc").map(publicPerson);
const lockedEnvironment = async () => ({
  ...(ONE_KENAN ? { custody: { oneKenan: true, locked: (await custodyStatus(ONE_KENAN))?.locked ?? true,
    message: "Kenan holds the folder keys. After a restart, the first enrolled person to log in opens custody and every known folder." } } : {}),
  id: ENVIRONMENT_ID, name: ENVIRONMENT_NAME, requiresUnlock: true, persons, profiles: [],
  ...(login ? { authentication: { type: "oidc", loginPath: "/v1/auth/login", label: "Sign in with Google" } satisfies HostAuthentication } : {}),
  capabilities: { voice: true, downloads: true, notifications: true, files: true },
});
const locked = (user?: string) => Response.json({ error: "Unlock to continue", locked: true, ...(!user ? { choosePerson: true } : { user }), persons }, { status: 423 });

for (const person of PEOPLE) {
  if (person.unlock || (await unitActive(person))) continue;
  const result = await start(person, "");
  if (!result.ok) console.error(`pi-remote router: could not start ${person.user}: ${result.error}`);
}

let provisioning = Promise.resolve();
async function oauthRoute(req: Request, url: URL): Promise<Response> {
  if (!login) return Response.json({ error: "OAuth is not configured" }, { status: 404 });
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const headers = new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
  if (url.pathname === "/v1/auth/session") {
    const origin = req.headers.get("origin");
    if ((origin && origin !== new URL(login.settings.publicUrl).origin) || req.headers.get("sec-fetch-site") === "cross-site") {
      return Response.json({ error: "Use the sign-in page on this host" }, { status: 403, headers });
    }
    const token = login.readCookie(req);
    const session = sessions.get(token);
    if (!session) return Response.json({ error: "Sign in to continue" }, { status: 423, headers });
    return Response.json({ ok: true, user: session.user, session: token }, { headers });
  }
  if (url.pathname === "/v1/auth/login") {
    const result = await login.begin();
    if (!result.ok) return Response.json({ error: result.error }, { status: 503, headers });
    headers.set("location", result.value.location);
    headers.set("set-cookie", result.value.cookie);
    return new Response(null, { status: 302, headers });
  }
  if (url.pathname !== "/v1/auth/callback") return new Response("Not found", { status: 404, headers });
  headers.append("set-cookie", login.cookie(login.transactionCookie, "", 0));
  const identity = await login.finish(req);
  const failure = (message: string, status: number) => {
    headers.set("content-type", "text/html; charset=utf-8");
    // Messages are fixed application strings, never provider or hook output.
    return new Response(`<!doctype html><html><meta name="viewport" content="width=device-width"><title>Pi Stack sign-in</title><body><h1>Sign-in could not finish</h1><p>${message}</p><a href="./login">Sign in again</a></body></html>`, { status, headers });
  };
  if (!identity.ok) return failure(identity.error, 403);
  const operation = provisioning.then(async () => {
    const provisioned = await login.provision(identity.value);
    if (!provisioned.ok) return failure(provisioned.error, 503);
    const person = listPersons().find(person => person.user === provisioned.value.user);
    if (!person || person.auth !== "oidc" || !person.unlock || person.environment.PI_REMOTE_ENVIRONMENT_ID !== ENVIRONMENT_ID) {
      return failure("The host did not register an isolated OAuth account.", 503);
    }
    const allowed = personEnvironments(person, environments, ENVIRONMENT_ID);
    byUser.set(person.user, person);
    grants.set(person.user, allowed);
    const index = PEOPLE.findIndex(existing => existing.user === person.user);
    if (index < 0) PEOPLE.push(person); else PEOPLE[index] = person;
    return serialized(person, async () => {
      const started = await start(person, provisioned.value.key);
      if (!started.ok) return failure("Your account was created but its private folder could not start. Please try again.", 503);
      headers.append("set-cookie", login.cookie(login.cookieName, sessions.issue(person.user), 8 * 60 * 60));
      headers.set("location", login.settings.publicUrl);
      return new Response(null, { status: 303, headers });
    });
  });
  provisioning = operation.then(() => undefined, () => undefined);
  try { return await operation; }
  catch { return failure("The host could not finish account setup. Please try again.", 503); }
}

async function route(req: Request, url: URL): Promise<Response> {
  if (url.pathname.startsWith("/calendar-feed/")) {
    const match = /^\/calendar-feed\/([a-z_][a-z0-9_-]*)\/([a-f0-9]{64})\.ics$/.exec(url.pathname);
    const person = match && PEOPLE.find(p => p.user === match[1]);
    if (req.method !== "GET" || !match || !person) return new Response("Not found", { status: 404 });
    try {
      return await proxyFetch(`http://127.0.0.1:${person.port}/v1/calendar/feed/${match[2]}`, { signal: AbortSignal.timeout(5000), redirect: "manual" });
    } catch { return new Response("Calendar unavailable while the person's folder is locked", { status: 503, headers: { "cache-control": "no-store" } }); }
  }
  const appUpdate = await appUpdateResponse(req);
  if (appUpdate) return appUpdate;
  if (url.pathname === "/v1/router-health") {
    const people = await Promise.all(PEOPLE.map(async (person) => ({ user: person.user, unlocked: await unitActive(person) })));
    return Response.json({ ok: true, version: VERSION, environmentId: ENVIRONMENT_ID, people, authentication: login ? "oidc" : "key",
      ...(ONE_KENAN ? { custody: await custodyStatus(ONE_KENAN) } : {}) });
  }
  if (url.pathname === "/v1/network" && req.method === "GET") return Response.json(networkStatus(privateNetwork, req));
  const asset = webResponse(WEB_DIR, url.pathname, req.method, req);
  if (asset) return asset;

  const identity = requestIdentity(req, url);
  if (identity.error) return identity.error;
  const { authenticated, asserted, person } = identity;
  if (url.pathname === "/v1/environment" && req.method === "GET" && !authenticated) return Response.json({ environment: await lockedEnvironment() });
  if (asserted && !person) return Response.json({ error: "This machine does not know you. Ask to be added to Pi Remote.", persons }, { status: 403 });

  if (url.pathname === "/v1/unlock" && req.method === "POST") {
    if (login || person?.auth === "oidc") return Response.json({ error: "Use company sign-in", locked: true }, { status: 423 });
    if (!person) return locked();
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || (body.key !== undefined && typeof body.key !== "string")) return Response.json({ error: "Expected an unlock key" }, { status: 400 });
    return serialized(person, async () => {
      const result = await start(person, body.key ?? "");
      if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
      return Response.json({ ok: true, user: person.user, session: sessions.issue(person.user) });
    });
  }
  if (!authenticated || !person) return locked(person?.user);

  if (url.pathname === "/v1/lock" && req.method === "POST") {
    return serialized(person, async () => {
      const stopped = await forget(person);
      return Response.json({ ok: stopped.ok, error: stopped.ok ? undefined : "Could not stop the supervisor" }, { status: stopped.ok ? 200 : 500 });
    });
  }
  if (!(await routedActive(person))) {
    sessions.revoke(person.user);
    return locked(person.user);
  }
  if (url.pathname === "/v1/admin/root-sessions" || url.pathname.startsWith("/v1/admin/root-sessions/")) {
    try {
      const rootDebug = await rootDebugResponse(req, { authenticatedUser: authenticated.user, persons: listPersons(), config: rootDebugConfig(), signal: authenticated.signal });
      if (rootDebug) return rootDebug;
    } catch {
      return (await rootDebugResponse(req, { authenticatedUser: authenticated.user, persons: [], config: null }))!;
    }
  }
  if (url.pathname === "/v1/lock-status") return Response.json({ user: person.user, unlocked: true });
  if (url.pathname === "/v1/environments" && req.method === "GET") return Response.json({ environments: publicEnvironments(grants.get(person.user)!) });
  // The internal room owner API accepts only router-generated requests, never browser proxying.
  if (rooms && (url.pathname.startsWith("/v1/room-owner/") || /^\/v1\/remotes\/[^/]+\/v1\/(rooms|room-owner)(\/|$)/.test(url.pathname))) return Response.json({ error: "Use this host's room directory" }, { status: 403 });
  if (rooms && /^\/v1\/rooms(?:\/|$)/.test(url.pathname)) return rooms.handle(req, person.user);
  const destination = proxyDestination(person, url);
  if ("error" in destination) return destination.error;
  return proxy(person, destination.origin, req, destination.target, authenticated.signal, destination.upstream);
}

Bun.serve<ProxySocketData>({
  hostname: HOST, port: PORT, idleTimeout: 60,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/v1/auth/")) return oauthRoute(req, url);
    if (req.method === "OPTIONS" && url.pathname.startsWith("/v1/")) return preflight();
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") return websocketRoute(req, url, server);
    const response = await route(req, url);
    if (!url.pathname.startsWith("/v1/")) return response;
    // A fresh cached private response must carry the authenticated session in
    // its URL. Header/cookie-only URLs can revalidate but cannot cross a later
    // account switch through a cache entry keyed only by attachment id.
    const immutable = req.method === "GET" && [200, 206, 304].includes(response.status)
      && response.headers.get("cache-control")?.includes("immutable");
    const scopedSession = url.searchParams.get("session");
    const cache = response.headers.get("cache-control");
    const authorizedResponse = [200, 206, 304].includes(response.status);
    response.headers.set("cache-control", immutable
      ? scopedSession ? "private, max-age=31536000, immutable" : "private, no-cache"
      : authorizedResponse && !cache?.includes("no-store") ? "private, no-cache" : "no-store");
    response.headers.set("vary", [response.headers.get("vary"), "X-Pi-Remote-User", "X-Pi-Remote-Session", "Cookie"].filter(Boolean).join(", "));
    response.headers.set("referrer-policy", "no-referrer");
    return withCors(response);
  },
  websocket: proxyWebsocket,
});
console.log(`pi-remote router ${VERSION} on http://${HOST}:${PORT} for ${PEOPLE.map((p) => p.user).join(", ")}`);
