import { webResponse } from "./files";
import { appUpdateResponse } from "./app-update";
import { unlink, writeFile, readFile, mkdir, chmod } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { listPersons, publicPerson, type Person } from "./persons";
import { configuredEnvironments, personEnvironments, publicEnvironments } from "./environments";
import { RouterSessions } from "./router-sessions";
import { proxyFetch } from "./proxy-fetch";
import { preflight, withCors } from "./cors";

const PORT = Number(process.env.PI_REMOTE_ROUTER_PORT ?? "8788");
const HOST = process.env.PI_REMOTE_ROUTER_HOST ?? "127.0.0.1";
const KEY_DIR = process.env.PI_REMOTE_KEY_DIR ?? "/run/pi-remote-keys";
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
const sessions = new RouterSessions();
const activeUsers = new Set<string>();
const unit = (person: Person) => `pi-remote@${person.user}.service`;
const operations = new Map<string, Promise<unknown>>();

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

type StartResult = { ok: true } | { ok: false; error: string; status: number };
async function start(person: Person, key: string): Promise<StartResult> {
  if (person.unlock && !key) return { ok: false, error: "Key required", status: 400 };
  if (await unitActive(person)) {
    if (!person.unlock) return { ok: true };
    // A mounted folder proves the retained credential, not a new caller's key.
    const retained = await readFile(join(KEY_DIR, person.user)).catch(() => null);
    if (!retained) return { ok: false, error: "Active folder has no retained unlock credential; stop its unit before unlocking", status: 503 };
    const supplied = Buffer.from(key);
    return retained.length === supplied.length && timingSafeEqual(retained, supplied)
      ? { ok: true }
      : { ok: false, error: "Wrong key", status: 403 };
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
    const deadline = Date.now() + UNLOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await supervisorHealthy(person)) return { ok: true };
      const state = await activeState(person);
      if (state === "failed" || state === "inactive") break;
      await Bun.sleep(200);
    }
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
async function proxy(person: Person, origin: string, req: Request, url: URL, signal: AbortSignal): Promise<Response> {
  const headers = new Headers(req.headers);
  for (const name of (headers.get("connection") ?? "").split(",")) if (name.trim()) headers.delete(name.trim());
  for (const name of [...headers.keys()]) {
    if (HOP_BY_HOP.has(name) || ["host", "cookie", "authorization", "forwarded"].includes(name) || name.startsWith("x-forwarded-") || name.startsWith("x-pi-remote-")) headers.delete(name);
  }
  headers.set("x-pi-remote-user", person.user);
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

const persons = PEOPLE.map(publicPerson);
const lockedEnvironment = () => ({
  id: ENVIRONMENT_ID, name: ENVIRONMENT_NAME, requiresUnlock: true, persons, profiles: [],
  capabilities: { voice: true, downloads: true, notifications: true, files: true },
});
const locked = (user?: string) => Response.json({ error: "Unlock to continue", locked: true, ...(!user ? { choosePerson: true } : { user }), persons }, { status: 423 });

for (const person of PEOPLE) {
  if (person.unlock || (await unitActive(person))) continue;
  const result = await start(person, "");
  if (!result.ok) console.error(`pi-remote router: could not start ${person.user}: ${result.error}`);
}

async function route(req: Request, url: URL): Promise<Response> {
  const appUpdate = await appUpdateResponse(req);
  if (appUpdate) return appUpdate;
  if (url.pathname === "/v1/router-health") {
    const people = await Promise.all(PEOPLE.map(async (person) => ({ user: person.user, unlocked: await unitActive(person) })));
    return Response.json({ ok: true, version: VERSION, environmentId: ENVIRONMENT_ID, people });
  }
  const asset = webResponse(WEB_DIR, url.pathname, req.method);
  if (asset) return asset;

  const names = assertedNames(req, url);
  const tokens = [req.headers.get("x-pi-remote-session"), ...url.searchParams.getAll("session")].filter((token): token is string => Boolean(token));
  if (new Set(names).size > 1 || new Set(tokens).size > 1) return Response.json({ error: "Conflicting identity" }, { status: 403 });
  const authenticated = sessions.get(tokens[0] ?? null);
  if (authenticated && names.some((name) => name !== authenticated.user)) return Response.json({ error: "Session belongs to another person" }, { status: 403 });
  const asserted = names[0];
  const person = authenticated ? byUser.get(authenticated.user)! : asserted ? byUser.get(asserted) : PEOPLE.length === 1 ? PEOPLE[0]! : undefined;
  if (asserted && !person) return Response.json({ error: "This machine does not know you. Ask to be added to Pi Remote.", persons }, { status: 403 });

  if (url.pathname === "/v1/unlock" && req.method === "POST") {
    if (!person) return locked();
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || (body.key !== undefined && typeof body.key !== "string")) return Response.json({ error: "Expected an unlock key" }, { status: 400 });
    return serialized(person, async () => {
      const result = await start(person, body.key ?? "");
      if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
      return Response.json({ ok: true, user: person.user, session: sessions.issue(person.user) });
    });
  }
  if (url.pathname === "/v1/environment" && req.method === "GET" && !authenticated) return Response.json({ environment: lockedEnvironment() });
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
  if (url.pathname === "/v1/lock-status") return Response.json({ user: person.user, unlocked: true });
  if (url.pathname === "/v1/environments" && req.method === "GET") return Response.json({ environments: publicEnvironments(grants.get(person.user)!) });
  if (url.pathname.startsWith("/v1/remotes/")) {
    const match = /^\/v1\/remotes\/([a-z][a-z0-9-]{0,31})(\/v1\/.*)$/.exec(url.pathname);
    if (!match) return Response.json({ error: "Unknown remote route" }, { status: 404 });
    const endpoint = grants.get(person.user)!.find((endpoint) => endpoint.id === match[1]);
    if (!endpoint?.upstreams?.[person.user]) return Response.json({ error: "Endpoint access denied" }, { status: 403 });
    if (/^\/v1\/(remotes|unlock|lock|lock-status|environments|router-health)(\/|$)/.test(match[2]!)) return Response.json({ error: "Use the identity router for this operation" }, { status: 403 });
    const target = new URL(url);
    target.pathname = match[2]!;
    return proxy(person, endpoint.upstreams[person.user]!, req, target, authenticated.signal);
  }
  if (!url.pathname.startsWith("/v1/")) return new Response("Not found", { status: 404 });
  return proxy(person, `http://127.0.0.1:${person.port}`, req, url, authenticated.signal);
}

Bun.serve({
  hostname: HOST, port: PORT, idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS" && url.pathname.startsWith("/v1/")) return preflight();
    const response = await route(req, url);
    if (!url.pathname.startsWith("/v1/")) return response;
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return withCors(response);
  },
});
console.log(`pi-remote router ${VERSION} on http://${HOST}:${PORT} for ${PEOPLE.map((p) => p.user).join(", ")}`);
