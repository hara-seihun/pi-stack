// Pi Remote's person registry. One JSON file per unix account under
// PI_REMOTE_PERSONS_DIR, written by `pi-remote person add` and read by the
// front door (to know who exists and where her supervisor listens), by the
// launcher (to know which folder to mount), and by the supervisor itself (as
// its PI_REMOTE_CONFIG, so the same file is the whole per-person configuration).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PERSONS_DIR = process.env.PI_REMOTE_PERSONS_DIR ?? "/var/lib/pi-remote/persons";

export type Person = {
  version: 1;
  user: string;
  displayName: string;
  port: number;
  /** Present when the person's folder is a gocryptfs directory that needs her key. */
  unlock?: { cipherDir: string; mountpoint: string };
  environment: Record<string, string | number | boolean | object>;
};

export function personPath(user: string, dir = PERSONS_DIR): string {
  return join(dir, `${user}.json`);
}

export function readPerson(path: string): Person {
  const person = JSON.parse(readFileSync(path, "utf8")) as Person;
  if (person.version !== 1) throw new Error(`${path}: unsupported person file version`);
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(person.user)) throw new Error(`${path}: invalid unix user ${person.user}`);
  if (!Number.isInteger(person.port) || person.port <= 0) throw new Error(`${path}: port must be a positive integer`);
  if (!person.environment || typeof person.environment !== "object") throw new Error(`${path}: environment object required`);
  if (person.unlock && (!person.unlock.cipherDir || !person.unlock.mountpoint)) throw new Error(`${path}: unlock needs cipherDir and mountpoint`);
  return person;
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

/**
 * The environments a browser client served from this host may switch among:
 * this one and any others reachable through a path prefix on the same origin.
 * Declared in each person's environment as PI_REMOTE_ENVIRONMENTS; the default
 * is this host alone.
 */
export function knownEnvironments(environment: Record<string, unknown> = process.env as Record<string, unknown>) {
  const own = { id: String(environment.PI_REMOTE_ENVIRONMENT_ID ?? "local"), name: String(environment.PI_REMOTE_ENVIRONMENT_NAME ?? "Local"), baseUrl: "" };
  const raw = environment.PI_REMOTE_ENVIRONMENTS;
  if (raw === undefined || raw === "") return [own];
  const declared = (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{ id: string; name?: string; baseUrl?: string }>;
  if (!Array.isArray(declared) || declared.length === 0) throw new Error("PI_REMOTE_ENVIRONMENTS must be a non-empty list");
  return declared.map((entry) => {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(entry.id)) throw new Error(`PI_REMOTE_ENVIRONMENTS: invalid id ${entry.id}`);
    return { id: entry.id, name: String(entry.name ?? entry.id), baseUrl: String(entry.baseUrl ?? "").replace(/\/+$/, "") };
  });
}
