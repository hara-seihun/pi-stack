import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const repository = resolve(import.meta.dir, "..");
export const fixturePeople = ["alice", "bob"] as const;
export type FixturePerson = typeof fixturePeople[number] | "admin";

/** Owns real Remote processes; the fixture systemctl never reaches the host manager. */
export class StagingStack {
  readonly root: string;
  readonly base: string;
  readonly hostFile: string;
  readonly children: Array<{ name: string; child: ReturnType<typeof Bun.spawn> }> = [];
  readonly tokens = new Map<FixturePerson, string>();
  readonly ports: Record<FixturePerson | "router", number>;
  readonly people: readonly FixturePerson[];
  routerAsRoot = false;
  constructor(root = mkdtempSync(join(tmpdir(), "pi-one-kenan-")), port = 19880, includeAdministrator = false) {
    this.root = resolve(root);
    this.people = includeAdministrator ? [...fixturePeople, "admin"] : fixturePeople;
    this.ports = { router: port, alice: port + 1, bob: port + 2, admin: port + 7 };
    for (const value of Object.values(this.ports)) {
      if (!Number.isInteger(value) || value < 1024 || value > 65535 || value >= 18790 && value <= 18799 || value >= 2461 && value <= 2474)
        throw new Error("Staging requires unreserved, nonprivileged ports");
    }
    this.base = `http://127.0.0.1:${port}`;
    this.hostFile = join(this.root, "host.json");
  }
  initialize() {
    for (const name of ["persons", "keys", "units", "bin", "logs", "upstream-credentials", ...this.people])
      mkdirSync(join(this.root, name), { recursive: true, mode: 0o700 });
    writeFileSync(this.hostFile, JSON.stringify({ version: 1, environments: [{ id: "staging", name: "Fixture staging", icon: "home" }] }));
    chmodSync(this.hostFile, 0o644);
    writeFileSync(join(this.root, "bin", "systemctl"), `#!/usr/bin/env bash
set -euo pipefail
root=${JSON.stringify(this.root)}
case "$1" in
  start)
    user=\${2#pi-remote@}; user=\${user%.service}
    [[ $user == alice || $user == bob || $user == admin ]] || exit 64
    [[ $(<"$root/keys/$user") == "$user-fixture-key" ]] || exit 1
    touch "$root/units/$2" ;;
  stop) rm -f "$root/units/$2" ;;
  reset-failed) exit 0 ;;
  show) unit=\${@: -1}; if [[ -f $root/units/$unit ]]; then echo active; else echo inactive; fi ;;
  *) echo 'Fixture systemctl refuses this operation' >&2; exit 64 ;;
esac
`, { mode: 0o700 });
    for (const user of this.people) {
      const home = join(this.root, user);
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      mkdirSync(join(home, "private"), { recursive: true });
      writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: [join(repository, "apps/remote")] }));
      writeFileSync(join(this.root, "persons", `${user}.json`), JSON.stringify({ version: 1, user,
        displayName: `${user} Fixture`, port: this.ports[user], remoteAccess: ["staging"],
        ...(user === "admin" ? { machineAdministrator: true } : {}),
        unlock: { cipherDir: join(home, "cipher"), mountpoint: join(home, "private") }, environment: {
          PI_REMOTE_ENVIRONMENT_ID: "staging", PI_REMOTE_ENVIRONMENT_NAME: "Fixture staging", PI_REMOTE_REQUIRES_UNLOCK: true,
        } }));
    }
  }
  environment(user?: FixturePerson): Record<string, string> {
    // In particular, no live broker, thread URL, account store or authentication is inherited.
    const home = join(this.root, user ?? "router-home");
    mkdirSync(home, { recursive: true });
    return {
      PATH: `${join(this.root, "bin")}:${process.env.PATH}`, HOME: home, USER: user ?? "staging", LANG: "C.UTF-8",
      TMPDIR: this.root, PI_STACK_HOST_FILE: this.hostFile, PI_STACK_HOST_CONFIG: this.hostFile,
      PI_KENAN_CONFIG: join(this.root, "one-kenan.json"),
      PI_REMOTE_PERSONS_DIR: join(this.root, "persons"), PI_REMOTE_KEY_DIR: join(this.root, "keys"),
      PI_REMOTE_UPSTREAM_CREDENTIAL_DIR: join(this.root, "upstream-credentials"),
      PI_REMOTE_ROOMS_DB: join(this.root, "rooms.sqlite3"),
      PI_REMOTE_ROUTER_HOST: "127.0.0.1", PI_REMOTE_ROUTER_PORT: String(this.ports.router),
      PI_REMOTE_UNLOCK_TIMEOUT_MS: "2000", PI_REMOTE_OIDC_CONFIG: "",
      PI_ORCHESTRATOR_CONFIG: join(home, "orchestrator.json"),
      ...(user ? {
        PI_REMOTE_CONFIG: join(this.root, "persons", `${user}.json`), PI_REMOTE_HOST: "127.0.0.1",
        PI_REMOTE_PORT: String(this.ports[user]), PI_REMOTE_DATA: join(home, "remote"),
        PI_AGENT_DIR: join(home, ".pi", "agent"), PI_REMOTE_PRIVATE_DIR: join(home, "private"),
        PI_REMOTE_ORCHESTRATOR_DB: join(home, "ledger.sqlite3"), PI_REMOTE_WATCH_ENABLED: "0",
        PI_REMOTE_WORKSPACES: JSON.stringify([{ id: "home", name: "Fixture home", path: home }]),
        PI_REMOTE_DESTINATIONS: "home",
      } : {}),
    };
  }
  spawn(name: string, file: string, user?: FixturePerson) {
    const log = Bun.file(join(this.root, "logs", `${name}.log`));
    const env = this.environment(user);
    const command = name === "router" && this.routerAsRoot
      ? ["sudo", "-n", "env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), process.execPath, file]
      : [process.execPath, file];
    const child = Bun.spawn(command, { cwd: repository, env, stdout: log, stderr: log });
    this.children.push({ name, child });
    return child;
  }
  async start() {
    try {
      for (const user of this.people) this.spawn(user, join(repository, "apps/remote/server/main.ts"), user);
      this.spawn("router", join(repository, "apps/remote/server/router.ts"));
      await Promise.all([
        this.ready(`${this.base}/v1/router-health`, "router"),
        ...this.people.map(user => this.ready(`http://127.0.0.1:${this.ports[user]}/v1/health`, user)),
      ]);
    } catch (error) { await this.stop(); throw error; }
  }
  async ready(url: string, name: string) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const child = this.children.find(item => item.name === name)?.child;
      if (child?.exitCode !== null) break;
      try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
      await Bun.sleep(20);
    }
    throw new Error(`${name} not ready: ${readFileSync(join(this.root, "logs", `${name}.log`), "utf8").slice(-8000)}`);
  }
  async stop() {
    for (const { child } of [...this.children].reverse()) if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.all(this.children.map(async ({ child }) => {
      const ended = await Promise.race([child.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
      if (!ended) { child.kill("SIGKILL"); await child.exited; }
    }));
    this.children.length = 0;
    this.tokens.clear();
  }
  async unlock(user: FixturePerson, key = `${user}-fixture-key`) {
    const response = await fetch(`${this.base}/v1/unlock`, { method: "POST", headers: { "x-pi-remote-user": user, "content-type": "application/json" }, body: JSON.stringify({ key }) });
    const body = await response.json();
    if (response.ok) this.tokens.set(user, body.session);
    return { status: response.status, body };
  }
  request(user: FixturePerson, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    return fetch(`${this.base}${path}`, { method, headers: {
      "x-pi-remote-user": user, "x-pi-remote-session": this.tokens.get(user) ?? "", "content-type": "application/json",
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  }
}

export async function checkFlagOff(stack: StagingStack) {
  const checks: string[] = [];
  function check(value: unknown, message: string) { if (!value) throw new Error(message); checks.push(message); }
  check(!(JSON.parse(readFileSync(stack.hostFile, "utf8"))).oneKenan, "host flag absent");
  const bootstrap = await (await fetch(`${stack.base}/v1/environment`)).json();
  check(bootstrap.environment.persons.map((item: any) => item.user).join(",") === "alice,bob", "fixture registry only");
  check((await stack.request("alice", "/v1/sessions")).status === 423, "locked client cannot read sessions");
  for (const user of fixturePeople) {
    check((await stack.unlock(user)).status === 200, `${user} own key accepted`);
    check((await stack.unlock(user, "wrong-fixture-key")).status === 403, `${user} wrong key refused while active`);
  }
  const id = randomUUID();
  const created = await stack.request("alice", "/v1/sessions", { requestId: id, destination: "home", model: "astra" });
  const body = await created.json();
  check(created.status === 201, `real thread created without invoking a model: ${created.status}`);
  const threadId = body.session.id;
  check((await stack.request("alice", `/v1/sessions/${threadId}`)).ok, "creator can read own thread");
  check((await stack.request("bob", `/v1/sessions/${threadId}`)).status === 404, "flag-off other person cannot read thread");
  const mismatch = await fetch(`${stack.base}/v1/sessions`, { headers: { "x-pi-remote-user": "bob", "x-pi-remote-session": stack.tokens.get("alice")! } });
  check(mismatch.status === 403, "person/session mismatch refused");
  await stack.stop();
  await stack.start();
  check((await stack.unlock("alice")).status === 200, "own key works after fixture process restart");
  check((await stack.request("alice", `/v1/sessions/${threadId}`)).ok, "thread persists across fixture process restart");
  return checks;
}

if (import.meta.main) {
  const rootIndex = process.argv.indexOf("--root"), portIndex = process.argv.indexOf("--port");
  const stack = new StagingStack(rootIndex < 0 ? undefined : process.argv[rootIndex + 1], portIndex < 0 ? undefined : Number(process.argv[portIndex + 1]));
  const onSignal = () => { void stack.stop().then(() => process.exit(130)); };
  process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);
  try {
    stack.initialize();
    await stack.start();
    console.log(`Fixture staging ready: ${stack.base}; root=${stack.root}`);
    const checks = await checkFlagOff(stack);
    const proof = { at: new Date().toISOString(), phase: "flag-off", base: stack.base, root: stack.root, checks };
    writeFileSync(join(stack.root, "proof.json"), JSON.stringify(proof, null, 2));
    console.log(JSON.stringify(proof));
  } finally { await stack.stop(); }
}
