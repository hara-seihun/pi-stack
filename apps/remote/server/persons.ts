// Pi Remote's person registry. One JSON file per unix account under
// PI_REMOTE_PERSONS_DIR, written by `pi-remote person add` and read by the
// front door (to know who exists and where her supervisor listens), by the
// launcher (to know which folder to mount), and by the supervisor itself (as
// its PI_REMOTE_CONFIG, so the same file is the whole per-person configuration).
import { closeSync, existsSync, fchmodSync, fchownSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PERSONS_DIR = process.env.PI_REMOTE_PERSONS_DIR ?? "/var/lib/pi-remote/persons";

export type Person = {
  version: 1;
  user: string;
  displayName: string;
  port: number;
  remoteAccess?: string[];
  auth?: "oidc";
  /** Present when the person's folder is a gocryptfs directory that needs her key. */
  unlock?: { cipherDir: string; mountpoint: string };
  environment: Record<string, string | number | boolean | object>;
};

export function personPath(user: string, dir = PERSONS_DIR): string {
  return join(dir, `${user}.json`);
}

export function readPerson(path: string): Person {
  return parsePerson(readFileSync(path, "utf8"), path);
}

export function parsePerson(source: string, path: string): Person {
  const person = JSON.parse(source) as Person;
  if (person.version !== 1) throw new Error(`${path}: unsupported person file version`);
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(person.user)) throw new Error(`${path}: invalid unix user ${person.user}`);
  if (!Number.isInteger(person.port) || person.port <= 0) throw new Error(`${path}: port must be a positive integer`);
  if (person.remoteAccess !== undefined && (!Array.isArray(person.remoteAccess) || person.remoteAccess.some((id) => typeof id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(id)) || new Set(person.remoteAccess).size !== person.remoteAccess.length)) throw new Error(`${path}: remoteAccess must contain unique endpoint ids`);
  if (!person.environment || typeof person.environment !== "object") throw new Error(`${path}: environment object required`);
  if (person.auth !== undefined && person.auth !== "oidc") throw new Error(`${path}: unsupported authentication method`);
  if (person.auth === "oidc" && !person.unlock) throw new Error(`${path}: OAuth persons require an encrypted folder`);
  if (person.unlock && (!person.unlock.cipherDir || !person.unlock.mountpoint)) throw new Error(`${path}: unlock needs cipherDir and mountpoint`);
  return person;
}

export function writePerson(person: Person, dir = PERSONS_DIR): void {
  const path = personPath(person.user, dir);
  const source = `${JSON.stringify(person, null, 2)}\n`;
  parsePerson(source, path);
  const previous = existsSync(path) ? statSync(path) : undefined;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const fd = openSync(dir, "r");
    try { fchmodSync(fd, 0o755); } finally { closeSync(fd); }
  }
  const stage = mkdtempSync(join(dir, ".person-"));
  try {
    const candidate = join(stage, "person.json");
    const fd = openSync(candidate, "wx", 0o600);
    try {
      writeFileSync(fd, source);
      if (previous) fchownSync(fd, previous.uid, previous.gid);
      // Supervisors read this nonsecret registry as their own Unix users.
      fchmodSync(fd, 0o644);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(candidate, path);
    const directory = openSync(dir, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

export function listPersons(dir = PERSONS_DIR): Person[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readPerson(join(dir, name)));
}

/** What a client may know about a person before she has unlocked anything. */
export function publicPerson(person: Person) {
  return { user: person.user, displayName: person.displayName, requiresUnlock: Boolean(person.unlock) };
}
