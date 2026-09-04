// The front door, driven the way the two clients drive it: a browser on the
// same origin and the Android WebView from http://localhost with the person
// header. systemctl is a fake that records state; no unit is really started.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function person(user: string, encrypted: boolean, supervisorPort: number) {
  writeFileSync(join(persons, `${user}.json`), JSON.stringify({
    version: 1, user, displayName: user.toUpperCase(), port: supervisorPort,
    ...(encrypted ? { unlock: { cipherDir: `/home/${user}/.x.crypt`, mountpoint: `/home/${user}/x` } } : {}),
    environment: {
      PI_REMOTE_ENVIRONMENT_ID: "testenv", PI_REMOTE_ENVIRONMENT_NAME: "Test",
      PI_REMOTE_ENVIRONMENTS: [{ id: "testenv", name: "Test", baseUrl: "" }, { id: "other", name: "Other", baseUrl: "/other" }],
    },
  }));
}

beforeAll(async () => {
  for (const directory of [persons, bin, units, keys]) mkdirSync(directory, { recursive: true });
  person("alice", true, 19998);
  person("bob", false, 19999);
  // `start` records the unit as active; `show` reports it; `stop` forgets it.
  // A supervisor never actually comes up, so an unlock for alice ends as a
  // wrong key after the deadline, and bob's start is attempted at boot.
  writeFileSync(join(bin, "systemctl"), `#!/usr/bin/env bash
units=${JSON.stringify(units)}
case "$1" in
  start) touch "$units/$2"; exit 0 ;;
  stop) rm -f "$units/$2"; exit 0 ;;
  reset-failed) exit 0 ;;
  show) unit=\${@: -1}; if [[ -e $units/$unit ]]; then echo active; else echo inactive; fi ;;
  *) exit 1 ;;
esac
`);
  chmodSync(join(bin, "systemctl"), 0o755);
  router = Bun.spawn([process.execPath, join(import.meta.dir, "router.ts")], {
    cwd: import.meta.dir,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PI_REMOTE_ROUTER_PORT: String(port),
      PI_REMOTE_PERSONS_DIR: persons,
      PI_REMOTE_KEY_DIR: keys,
      PI_REMOTE_UNLOCK_TIMEOUT_MS: "300",
    },
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/v1/router-health`)).ok) return; } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`router did not start: ${await new Response(router.stderr as ReadableStream).text()}`);
});

afterAll(() => {
  router?.kill();
  rmSync(root, { recursive: true, force: true });
});

describe("Pi Remote front door", () => {
  test("serves the web client to anyone, since the client is what asks for a name and a key", async () => {
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    const html = await index.text();
    const scriptPath = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    expect(scriptPath).toBeTruthy();
    expect((await fetch(`${base}${scriptPath}`)).status).toBe(200);

    const stylesheetPath = html.match(/href="(\/vendor\/katex\/katex\.min\.css)"/)?.[1];
    expect(stylesheetPath).toBeTruthy();
    const stylesheet = await (await fetch(`${base}${stylesheetPath}`)).text();
    const fontPath = stylesheet.match(/url\((fonts\/KaTeX_Main-Regular\.woff2)\)/)?.[1];
    expect(fontPath).toBeTruthy();
    const font = await fetch(new URL(fontPath!, `${base}${stylesheetPath}`));
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
  });

  test("answers the Android preflight for the person header before any identity is known", async () => {
    const preflight = await fetch(`${base}/v1/environment`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost", "access-control-request-method": "GET", "access-control-request-headers": "x-pi-remote-user" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("x-pi-remote-user");
  });

  test("tells an unnamed client who it could be, with CORS so the Android shell can read it", async () => {
    const environment = await fetch(`${base}/v1/environment`);
    expect(environment.status).toBe(200);
    expect(environment.headers.get("access-control-allow-origin")).toBe("http://localhost");
    const body = await environment.json();
    expect(body.environment.id).toBe("testenv");
    expect(body.environment.requiresUnlock).toBe(true);
    expect(body.environment.persons).toEqual([
      { user: "alice", displayName: "ALICE", requiresUnlock: true },
      { user: "bob", displayName: "BOB", requiresUnlock: false },
    ]);
    const locked = await fetch(`${base}/v1/sessions`);
    expect(locked.status).toBe(423);
    expect(locked.headers.get("access-control-allow-origin")).toBe("http://localhost");
    expect((await locked.json()).choosePerson).toBe(true);
  });

  test("lists the environments the page may switch among", async () => {
    const response = await fetch(`${base}/v1/environments`);
    expect(await response.json()).toEqual({ environments: [
      { id: "testenv", name: "Test", baseUrl: "" },
      { id: "other", name: "Other", baseUrl: "/other" },
    ] });
  });

  test("refuses a name it does not know without pretending it is locked", async () => {
    const response = await fetch(`${base}/v1/sessions`, { headers: { "x-pi-remote-user": "mallory" } });
    expect(response.status).toBe(403);
  });

  test("a download link opened in a tab names its person in the query, since a navigation cannot carry a header", async () => {
    const status = await fetch(`${base}/v1/lock-status?user=alice`);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ user: "alice", unlocked: false });
    const locked = await fetch(`${base}/v1/sessions/thread/files?path=%2Ftmp%2Fnotes.md&user=alice`);
    expect(locked.status).toBe(423);
    expect((await locked.json()).locked).toBe(true);
    const unknown = await fetch(`${base}/v1/lock-status?user=mallory`);
    expect(unknown.status).toBe(403);
  });

  test("an encrypted person needs a key, and a key that does not open the folder is reported as wrong", async () => {
    const missing = await fetch(`${base}/v1/unlock`, { method: "POST", headers: { "x-pi-remote-user": "alice", "content-type": "application/json" }, body: "{}" });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe("Key required");
    const wrong = await fetch(`${base}/v1/unlock`, { method: "POST", headers: { "x-pi-remote-user": "alice", "content-type": "application/json" }, body: JSON.stringify({ key: "nope" }) });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toMatch(/Wrong key/);
    const status = await (await fetch(`${base}/v1/lock-status`, { headers: { "x-pi-remote-user": "alice" } })).json();
    expect(status.unlocked).toBe(false);
  });

  test("an open person's supervisor is started by the front door itself", async () => {
    const health = await (await fetch(`${base}/v1/router-health`)).json();
    // bob's unit was started at boot; the fake never answers health, so the
    // front door gave up and stopped it again, which is the honest state.
    expect(health.people).toEqual([{ user: "alice", unlocked: false }, { user: "bob", unlocked: false }]);
    const unlock = await fetch(`${base}/v1/unlock`, { method: "POST", headers: { "x-pi-remote-user": "bob", "content-type": "application/json" }, body: "{}" });
    expect(unlock.status).toBe(400);
    expect((await unlock.json()).error).toMatch(/did not come up/);
  });
});
