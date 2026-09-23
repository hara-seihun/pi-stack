import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personPath, readPerson, writePerson, type Person } from "./persons";

const person: Person = { version: 1, user: "testperson", displayName: "Test", port: 18790, environment: {} };

test("person writes remain supervisor-readable under the service umask and repair an unreadable replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "person-write-"));
  const dir = join(root, "persons");
  const mask = process.umask(0o077);
  try {
    writePerson(person, dir);
    const path = personPath(person.user, dir);
    const original = statSync(path);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(original.mode & 0o777).toBe(0o644);
    chmodSync(path, 0o600);
    const changed = { ...person, environment: { PI_REMOTE_DESTINATIONS: "personal,home,raw" } };
    writePerson(changed, dir);
    const replaced = statSync(path);
    expect(replaced.ino).not.toBe(original.ino);
    expect(replaced.uid).toBe(original.uid);
    expect(replaced.gid).toBe(original.gid);
    expect(replaced.mode & 0o777).toBe(0o644);
    expect(readPerson(path)).toEqual(changed);
    expect(readdirSync(dir)).toEqual(["testperson.json"]);
    const saved = readFileSync(path, "utf8");
    expect(() => writePerson({ ...changed, port: -1 }, dir)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(saved);
    expect(readdirSync(dir)).toEqual(["testperson.json"]);
  } finally {
    process.umask(mask);
    rmSync(root, { recursive: true, force: true });
  }
});
