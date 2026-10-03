import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Person } from "./persons";
import type { KenanKeys } from "./one-kenan-keys";

export function retainedCustodyKey(directory: string, person: Person): Buffer | null {
  if (!person.unlock || !/^[a-z_][a-z0-9_-]{0,31}$/.test(person.user)) return null;
  let fd: number | undefined;
  try {
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || parent.mode & 0o077) return null;
    fd = openSync(join(directory, person.user), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = fstatSync(fd);
    if (!file.isFile() || file.uid !== 0 || file.mode & 0o077 || file.size < 1 || file.size > 4096 || file.nlink !== 1) return null;
    const key = readFileSync(fd);
    if (!key.length || key.length > 4096 || /[\r\n\0]/.test(key.toString("utf8"))) { key.fill(0); return null; }
    return key;
  } catch (error) {
    if (["ENOENT", "ELOOP", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw new Error("Retained custody key file could not be inspected");
  } finally { if (fd !== undefined) closeSync(fd); }
}

export async function collectRetainedCustodyKeys(keys: KenanKeys, people: Person[], directory = process.env.PI_REMOTE_KEY_DIR ?? "/run/pi-remote-keys") {
  const collected: string[] = [], rejected: string[] = [];
  for (const person of people) {
    const key = retainedCustodyKey(directory, person);
    if (!key) continue;
    try {
      // Authentication must mount the encrypted folder successfully before retaining its key.
      const result = await keys.authenticate(person.user, key.toString("utf8"));
      (result.ok ? collected : rejected).push(person.user);
    } finally { key.fill(0); }
  }
  return { collected, rejected };
}
