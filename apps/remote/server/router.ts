// The front door. One process on the published port, holding no state and no
// keys, whose whole job is to decide which person is asking and hand the
// request to that person's own supervisor.
//
// A supervisor for a person with an encrypted folder only exists while her key
// is in memory, because the unit mounts her folder inside its own mount
// namespace before it starts. So "locked" here is not a flag this process
// keeps: it is `systemctl is-active` coming back false. A person without an
// encrypted folder has nothing to unlock, and her supervisor is started when
// the front door starts.
//
// Identity is whatever the client says it is, in `x-pi-remote-user`. The
// folders are what protect anything worth protecting, and they are open
// exactly when their owner is working; a name on a request grants nothing a
// key does not already grant. A host with one person needs no header at all.
import { existsSync } from "node:fs";
import { unlink, writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { listPersons, publicPerson, type Person } from "./persons";
import { proxyFetch } from "./proxy-fetch";

const PORT = Number(process.env.PI_REMOTE_ROUTER_PORT ?? "8788");
const HOST = process.env.PI_REMOTE_ROUTER_HOST ?? "127.0.0.1";
const KEY_DIR = process.env.PI_REMOTE_KEY_DIR ?? "/run/pi-remote-keys";
const WEB_DIR = join(import.meta.dir, "../web");
const UNLOCK_TIMEOUT_MS = Number(process.env.PI_REMOTE_UNLOCK_TIMEOUT_MS ?? "20000");
const VERSION = "2.0.0";

const PEOPLE = listPersons();
if (PEOPLE.length === 0) throw new Error("Pi Remote knows no persons; add one with `pi-remote person add`");
const environmentIds = new Set(PEOPLE.map((person) => String(person.environment.PI_REMOTE_ENVIRONMENT_ID ?? "local")));
if (environmentIds.size !== 1) throw new Error(`Persons disagree on the environment id: ${[...environmentIds].join(", ")}`);
const ENVIRONMENT_ID = [...environmentIds][0]!;
const ENVIRONMENT_NAME = String(PEOPLE[0]!.environment.PI_REMOTE_ENVIRONMENT_NAME ?? "Local");
if (!/^[a-z][a-z0-9-]{0,31}$/.test(ENVIRONMENT_ID)) throw new Error("PI_REMOTE_ENVIRONMENT_ID must be a stable lowercase identifier");

const byUser = new Map(PEOPLE.map((person) => [person.user, person]));
const activeUsers = new Set<string>();
const unit = (person: Person) => `pi-remote@${person.user}.service`;

function identify(req: Request): Person | null {
  const asserted = req.headers.get("x-pi-remote-user");
  if (asserted) return byUser.get(asserted) ?? null;
  return PEOPLE.length === 1 ? PEOPLE[0]! : null;
}

// `systemctl is-active` answers yes for a unit that is merely trying to start,
// so a supervisor whose key was wrong reads as unlocked for as long as it keeps
// failing. Ask for the state itself.
async function activeState(person: Person): Promise<string> {
  const proc = Bun.spawn(["systemctl", "show", "-p", "ActiveState", "--value", unit(person)], { stdout: "pipe", stderr: "ignore" });
  const [, state] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return state.trim();
}

async function unitActive(person: Person): Promise<boolean> {
  return (await activeState(person)) === "active";
}

async function routedActive(person: Person): Promise<boolean> {
  if (activeUsers.has(person.user)) return true;
  const active = await unitActive(person);
  if (active) activeUsers.add(person.user);
  return active;
}

// A wrong key fails the mount, and the unit is restarted a few times before
// systemd's start limit gives up. `failed` and `inactive` are the two ways it
// stops trying; anything else means it is still on its way up.
async function unitDead(person: Person): Promise<boolean> {
  const state = await activeState(person);
  return state === "failed" || state === "inactive";
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

// The key reaches the unit as a systemd credential, from a root-only file on
// tmpfs. It stays there for as long as she is unlocked, and goes when she locks
// or the machine reboots. Holding it is what lets systemd restart a supervisor
// that crashed, so a background thread does not stall until somebody opens the
// app. It is never in a command line, where /proc would expose it during exec.
//
// A person without an encrypted folder gets an empty credential: the launcher
// mounts nothing and the unit simply starts.
async function start(person: Person, key: string): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (person.unlock && !key) return { ok: false, error: "Key required", status: 400 };
  if (await unitActive(person)) return { ok: true };
  await mkdir(KEY_DIR, { recursive: true, mode: 0o700 });
  await chmod(KEY_DIR, 0o700);
  await writeFile(join(KEY_DIR, person.user), key, { mode: 0o600 });
  try {
    const started = await systemctl("start", unit(person));
    if (!started.ok) {
      await systemctl("stop", unit(person));
      return { ok: false, error: started.message || "Could not start the supervisor", status: 400 };
    }
    const deadline = Date.now() + UNLOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await supervisorHealthy(person)) return { ok: true };
      if (await unitDead(person)) break;
      await Bun.sleep(200);
    }
    await forget(person);
    return { ok: false, error: person.unlock ? "Wrong key, or the folder would not open" : "The supervisor did not come up", status: 400 };
  } catch (cause: any) {
    await forget(person);
    return { ok: false, error: cause?.message ?? "Could not start the supervisor", status: 500 };
  }
}

// Locking is stopping the unit and forgetting the key, in that order. The stop
// takes the mount namespace with it.
async function forget(person: Person): Promise<{ ok: boolean; message: string }> {
  activeUsers.delete(person.user);
  const stopped = await systemctl("stop", unit(person));
  await unlink(join(KEY_DIR, person.user)).catch(() => {});
  await systemctl("reset-failed", unit(person));
  return stopped;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".png": "image/png", ".ico": "image/x-icon",
};

// While a supervisor is down its owner still has to be able to load the app,
// because the app is what asks for the key. The front door serves exactly the
// same files the supervisor would, so there is no second login page to
// maintain and no way for the two to drift apart.
function webAsset(pathname: string): Response | null {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (relative.includes("..")) return null;
  const file = Bun.file(join(WEB_DIR, relative));
  if (!existsSync(join(WEB_DIR, relative))) return null;
  const extension = relative.slice(relative.lastIndexOf("."));
  return new Response(file, { headers: { "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream", "cache-control": "no-store" } });
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authorization", "te", "trailer"]);

async function proxy(person: Person, req: Request, url: URL): Promise<Response> {
  const headers = new Headers();
  for (const [name, value] of req.headers) if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
  const target = `http://127.0.0.1:${person.port}${url.pathname}${url.search}`;
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : req.body;
  try {
    const response = await proxyFetch(target, { method: req.method, headers, body, redirect: "manual", ...(body ? { duplex: "half" } : {}) } as RequestInit);
    const out = new Headers(response.headers);
    for (const name of HOP_BY_HOP) out.delete(name);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
  } catch (cause: any) {
    activeUsers.delete(person.user);
    return Response.json({ error: `Supervisor unreachable: ${cause?.message ?? cause}` }, { status: 502 });
  }
}

const persons = PEOPLE.map(publicPerson);
const lockedEnvironment = () => ({
  id: ENVIRONMENT_ID,
  name: ENVIRONMENT_NAME,
  requiresUnlock: true,
  persons,
  profiles: [],
  capabilities: { voice: true, downloads: true, notifications: true, files: true },
});

// Persons with nothing to unlock are started with the front door and again
// whenever their unit is found down, so a reboot never leaves them waiting for
// a client. Persons with encrypted folders wait for their key.
async function startOpenPersons() {
  for (const person of PEOPLE) {
    if (person.unlock || (await unitActive(person))) continue;
    const result = await start(person, "");
    if (!result.ok) console.error(`pi-remote router: could not start ${person.user}: ${result.error}`);
  }
}
await startOpenPersons();

Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/router-health") {
      const people = await Promise.all(PEOPLE.map(async (person) => ({ user: person.user, unlocked: await unitActive(person) })));
      return Response.json({ ok: true, version: VERSION, environmentId: ENVIRONMENT_ID, people });
    }

    const person = identify(req);
    if (!person) {
      if (url.pathname === "/v1/environment" && req.method === "GET") return Response.json({ environment: lockedEnvironment() });
      const asset = req.method === "GET" ? webAsset(url.pathname) : null;
      if (asset) return asset;
      if (req.headers.has("x-pi-remote-user")) return Response.json({ error: "This machine does not know you. Ask to be added to Pi Remote.", persons }, { status: 403 });
      return Response.json({ error: "Say who you are", choosePerson: true, persons }, { status: 423 });
    }

    if (url.pathname === "/v1/environment" && req.method === "GET" && !(await routedActive(person))) {
      if (!person.unlock) await start(person, "");
      if (!(await routedActive(person))) return Response.json({ environment: lockedEnvironment() });
    }

    if (url.pathname === "/v1/unlock" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const result = await start(person, String((body as any)?.key ?? ""));
      if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
      return Response.json({ ok: true, user: person.user });
    }
    if (url.pathname === "/v1/lock" && req.method === "POST") {
      const stopped = await forget(person);
      return Response.json({ ok: stopped.ok, error: stopped.ok ? undefined : stopped.message }, { status: stopped.ok ? 200 : 500 });
    }
    if (url.pathname === "/v1/lock-status") {
      return Response.json({ user: person.user, unlocked: await unitActive(person) });
    }

    if (await routedActive(person)) return proxy(person, req, url);
    if (!person.unlock) {
      const result = await start(person, "");
      if (result.ok) return proxy(person, req, url);
      return Response.json({ error: result.error }, { status: 503 });
    }

    const asset = webAsset(url.pathname);
    if (asset) return asset;
    return Response.json({ error: "Locked", locked: true, user: person.user, persons }, { status: 423 });
  },
});

console.log(`pi-remote router ${VERSION} on http://${HOST}:${PORT} for ${PEOPLE.map((p) => p.user).join(", ")}`);
