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
