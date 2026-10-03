import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
export function isPrivateMount(path: string, mountinfo = readFileSync("/proc/self/mountinfo", "utf8")): boolean {
  const expected = resolve(path);
  return mountinfo.split("\n").some(line => {
    const fields = line.split(" ");
    const mount = fields[4]?.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    return mount === expected && line.includes(" - fuse.gocryptfs ");
  });
}
export async function awaitPrivateMount(path: string, signal: AbortSignal): Promise<boolean> {
  while (!signal.aborted) {
    if (isPrivateMount(path)) return true;
    try { await setTimeout(500, undefined, { signal }); } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
  return false;
}
