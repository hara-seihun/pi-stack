// `pi-remote person ...`: the lifecycle of a Pi Remote person on this machine.
//
// A person is a unix account with a supervisor of her own. Adding one writes
// her registry file, creates her folder, and, unless asked not to, makes that
// folder a gocryptfs directory whose key is printed exactly once. Nothing here
// touches the unix account itself; the host creates that.
import { randomBytes } from "node:crypto";
import { chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPersons, parsePerson, personPath, writePerson, type Person } from "./persons";
import { threadNamingModel } from "./thread-naming";
import { defaultThreadDestinations } from "./thread-model-defaults";

const USAGE = `usage:
  pi-remote person list
  pi-remote person add USER --display-name NAME --thread-naming-model PROVIDER/MODEL:THINKING
                            [--folder NAME] [--no-encrypt] [--existing] [--port N] [--key-file PATH]
                            [--environment ID] [--environment-name NAME]
  pi-remote person update USER < person.json
  pi-remote person remove USER

add creates /home/USER/FOLDER (default FOLDER is USER). With encryption the
folder is a gocryptfs mount of /home/USER/.FOLDER.crypt and the key is printed
once; --key-file reads a host-managed key and never prints it. --existing adopts
a crypt directory that already exists and prints no key.
update validates a complete registry document from stdin and replaces the existing
file atomically, preserving ownership and supervisor-readable permissions. It does
not reload services. Keep credentials in their existing stores, not this document.
remove forgets the person and stops her supervisor. Her files are never deleted.`;

function flags(args: string[]): { named: Map<string, string>; positional: string[] } {
  const named = new Map<string, string>(); const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!;
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const [name, inline] = value.slice(2).split("=", 2);
    if (inline !== undefined) named.set(name!, inline);
    else if (args[i + 1] && !args[i + 1]!.startsWith("--")) named.set(name!, args[++i]!);
    else named.set(name!, "true");
  }
  return { named, positional };
}

function account(user: string): { uid: number; gid: number; home: string } {
  const entry = Bun.spawnSync(["getent", "passwd", user], { stdout: "pipe" });
  if (entry.exitCode !== 0) throw new Error(`no unix account named ${user}; create it first`);
  const [, , uid, gid, , home] = new TextDecoder().decode(entry.stdout).trim().split(":");
  return { uid: Number(uid), gid: Number(gid), home: home! };
}

function asUser(user: string, command: string[]): void {
  const result = Bun.spawnSync(["runuser", "-u", user, "--", ...command], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command[0]} failed for ${user}`);
}

function requireRoot(): void {
  if (process.getuid?.() !== 0) throw new Error("this command needs root; run it with sudo");
}

function defaultEnvironment(person: Omit<Person, "environment">, folder: string, home: string, homeName: string, environmentId: string, environmentName: string, threadNamingModel: string) {
  const privateDir = person.unlock?.mountpoint ?? join(home, folder);
  return {
    PI_REMOTE_ENVIRONMENT_ID: environmentId,
    PI_REMOTE_ENVIRONMENT_NAME: environmentName,
    PI_REMOTE_REQUIRES_UNLOCK: Boolean(person.unlock),
    PI_REMOTE_PRIVATE_ID: folder,
    PI_REMOTE_PRIVATE_NAME: person.displayName,
    PI_REMOTE_OPERATOR_NAME: person.displayName,
    PI_REMOTE_PRIVATE_DIR: privateDir,
    PI_REMOTE_DATA: join(privateDir, ".pi-remote"),
    PI_REMOTE_INGESTION: join(privateDir, ".ingestion"),
    PI_REMOTE_PORT: person.port,
    PI_REMOTE_THREAD_NAMING_MODEL: threadNamingModel,
    PI_REMOTE_DESTINATIONS: "personal,home,raw",
    PI_REMOTE_ORCHESTRATOR_DB: join(home, ".local/share/pi-orchestrator/ledger.sqlite3"),
    PI_REMOTE_ORCHESTRATOR_RUNS: join(home, ".local/share/pi-orchestrator/runs"),
    PI_REMOTE_WORKSPACES: [
      { id: "home", name: homeName, path: home },
      { id: folder, name: person.displayName, path: privateDir },
    ],
    PI_REMOTE_THREAD_DESTINATIONS: defaultThreadDestinations(folder),
  };
}

function add(args: string[]): void {
  requireRoot();
  const { named, positional } = flags(args);
  const user = positional[0];
  if (!user) throw new Error("add requires a unix user name");
  if (existsSync(personPath(user))) throw new Error(`${user} is already a Pi Remote person (${personPath(user)})`);
  const displayName = named.get("display-name");
  if (!displayName) throw new Error("--display-name is required");
  const namingModel = named.get("thread-naming-model");
  if (!namingModel) throw new Error("--thread-naming-model is required");
  const configuredNamingModel = threadNamingModel(namingModel);
  const { uid, gid, home } = account(user);
  const folder = named.get("folder") ?? user;
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(folder)) throw new Error("--folder must be a short lowercase name");
  const existing = listPersons();
  const taken = new Set(existing.map((person) => person.port));
  let port = Number(named.get("port") ?? 0);
  if (!port) { port = 18790; while (taken.has(port)) port++; }
  if (taken.has(port)) throw new Error(`port ${port} already belongs to another person`);
  const environmentId = named.get("environment") ?? String(existing[0]?.environment.PI_REMOTE_ENVIRONMENT_ID ?? "local");
  const environmentName = named.get("environment-name") ?? String(existing[0]?.environment.PI_REMOTE_ENVIRONMENT_NAME ?? "Local");
  const encrypt = !named.has("no-encrypt");
  const keyFile = named.get("key-file");
  if (keyFile && !encrypt) throw new Error("--key-file requires an encrypted folder");
  const mountpoint = join(home, folder);
  const cipherDir = join(home, `.${folder}.crypt`);

  let key: string | null = null;
  if (encrypt) {
    if (named.has("existing")) {
      if (!existsSync(join(cipherDir, "gocryptfs.conf"))) throw new Error(`--existing needs a gocryptfs directory at ${cipherDir}`);
    } else {
      if (existsSync(cipherDir)) throw new Error(`${cipherDir} already exists; pass --existing to adopt it`);
      key = keyFile ? readFileSync(keyFile, "utf8") : randomBytes(32).toString("base64url");
      if (!key || /[\r\n\0]/.test(key)) throw new Error("Folder key must be nonempty and contain no newline or NUL");
      const scratch = mkdtempSync(join(tmpdir(), "pi-remote-key-"));
      const passfile = join(scratch, "key");
      try {
        writeFileSync(passfile, key, { mode: 0o600 });
        chownSync(passfile, uid, gid);
        chownSync(scratch, uid, gid);
        mkdirSync(cipherDir, { mode: 0o700 });
        chownSync(cipherDir, uid, gid);
        asUser(user, ["gocryptfs", "-init", "-q", "-passfile", passfile, "--", cipherDir]);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  }
  if (!existsSync(mountpoint)) { mkdirSync(mountpoint, { mode: 0o700 }); chownSync(mountpoint, uid, gid); }

  const base: Omit<Person, "environment"> = {
    version: 1, user, displayName, port,
    ...(encrypt ? { unlock: { cipherDir, mountpoint } } : {}),
  };
  const homeName = named.get("home-name") ?? user.charAt(0).toUpperCase() + user.slice(1);
  const person: Person = { ...base, environment: defaultEnvironment(base, folder, home, homeName, environmentId, environmentName, configuredNamingModel) };
  writePerson(person);
  console.log(`added ${user} (${displayName}) on port ${port}; registry file ${personPath(user)}`);
  console.log(`use pi-remote person update ${user} with JSON on stdin to change this file; the front door reads it on restart`);
  if (key && !keyFile) {
    console.log("");
    console.log(`Folder key for ${user}. This is the only time it is shown. Losing it loses the folder.`);
    console.log("");
    console.log(`  ${key}`);
    console.log("");
  }
}

function update(args: string[]): void {
  requireRoot();
  const [user] = args;
  if (args.length !== 1 || !user || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error("update requires one unix user name");
  if (!existsSync(personPath(user))) throw new Error(`${user} is not a Pi Remote person`);
  const person = parsePerson(readFileSync(0, "utf8"), "stdin");
  if (person.user !== user) throw new Error(`stdin must describe ${user}`);
  if (listPersons().some((other) => other.user !== user && other.port === person.port)) throw new Error(`port ${person.port} already belongs to another person`);
  writePerson(person);
  console.log(`updated ${personPath(user)}; services unchanged`);
}

function remove(args: string[]): void {
  requireRoot();
  const user = flags(args).positional[0];
  if (!user) throw new Error("remove requires a unix user name");
  if (!existsSync(personPath(user))) throw new Error(`${user} is not a Pi Remote person`);
  Bun.spawnSync(["systemctl", "stop", `pi-remote@${user}.service`]);
  rmSync(join(process.env.PI_REMOTE_KEY_DIR ?? "/run/pi-remote-keys", user), { force: true });
  rmSync(personPath(user));
  console.log(`removed ${user}; her folder and threads were left in place`);
}

function list(): void {
  for (const person of listPersons()) {
    const state = Bun.spawnSync(["systemctl", "show", "-p", "ActiveState", "--value", `pi-remote@${person.user}.service`], { stdout: "pipe" });
    console.log(`${person.user}\t${person.displayName}\t:${person.port}\t${person.unlock ? "encrypted" : "open"}\t${new TextDecoder().decode(state.stdout).trim() || "unknown"}`);
  }
}

const [group, action, ...rest] = process.argv.slice(2);
try {
  if (group === undefined || group === "--help" || group === "-h" || group === "help") { console.log(USAGE); process.exit(0); }
  if (group !== "person") throw new Error(USAGE);
  if (action === "list") list();
  else if (action === "add") add(rest);
  else if (action === "update") update(rest);
  else if (action === "remove") remove(rest);
  else throw new Error(USAGE);
} catch (error: any) {
  console.error(error?.message ?? String(error));
  process.exit(1);
}
