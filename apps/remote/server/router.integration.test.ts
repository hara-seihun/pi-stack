import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pi-remote-router-test-"));
const persons = join(root, "persons");
const bin = join(root, "bin");
const units = join(root, "units");
const keys = join(root, "keys");
const port = 19000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let router: ReturnType<typeof Bun.spawn>;
const supervisors: ReturnType<typeof Bun.serve>[] = [];
let remoteCalls = 0;

function person(user: string, encrypted: boolean, remoteAccess: string[]) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (!existsSync(join(units, `pi-remote@${user}.service`))) return new Response("Stopped", { status: 503 });
    return Response.json({ user, path: new URL(req.url).pathname });
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
  const remote = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    remoteCalls++;
    const url = new URL(req.url);
    if (url.pathname === "/v1/redirect") return Response.redirect("https://example.org");
    return Response.json({ path: url.pathname, query: url.search, user: req.headers.get("x-pi-remote-user"), session: req.headers.get("x-pi-remote-session"), authorization: req.headers.get("authorization"), cookie: req.headers.get("cookie"), referer: req.headers.get("referer") });
  } });
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

async function startRouter() {
  router = Bun.spawn([process.execPath, join(import.meta.dir, "router.ts")], {
    stdout: "ignore", stderr: "pipe",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, PI_REMOTE_ROUTER_PORT: String(port), PI_REMOTE_PERSONS_DIR: persons, PI_STACK_HOST_FILE: join(root, "host.json"), PI_REMOTE_KEY_DIR: keys, PI_REMOTE_UNLOCK_TIMEOUT_MS: "300" },
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

test("each person's discovery is policy controlled; open guests receive no remote authority", async () => {
  for (const user of ["kenan", "sybil", "jodie", "guest"]) {
    const response = await request("/v1/environments", await token(user), user);
    const body = await response.json();
    expect(body.environments.map((e: any) => e.id)).toEqual(user === "kenan" ? ["desk", "lab"] : ["desk"]);
    expect(JSON.stringify(body)).not.toContain("upstreams");
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");
  }
});

test("remote requests, notifications and downloads share authorization without forwarding credentials", async () => {
  const owner = await token("kenan");
  for (const path of ["/v1/sessions", "/v1/notifications", "/v1/sessions/thread/files"]) {
    const response = await fetch(`${base}/v1/remotes/lab${path}?session=${owner}&user=kenan&path=%2Ftmp%2Fa`, { headers: { authorization: "Bearer private", cookie: "secret=value", referer: `${base}/v1/file?session=${owner}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path, query: "?path=%2Ftmp%2Fa", user: "kenan", session: null, authorization: null, cookie: null, referer: null });
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  }
  expect((await request("/v1/remotes/lab/v1/redirect", owner)).status).toBe(502);
  expect((await request("/v1/remotes/lab/v1/remotes/desk/v1/health", owner)).status).toBe(403);
  expect((await request("/v1/remotes/lab/v1/lock", owner)).status).toBe(403);
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
