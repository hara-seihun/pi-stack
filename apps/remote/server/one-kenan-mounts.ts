import { mkdirSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { Person } from "./persons";
import type { CustodyResult } from "./one-kenan-keys";

export function inheritedCustodyMounts(people: Person[], mountinfo = readFileSync("/proc/self/mountinfo", "utf8")): string[] {
  const registered = new Set(people.flatMap(person => person.unlock ? [resolve(person.unlock.mountpoint)] : []));
  const decode = (path: string) => path.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  return mountinfo.split("\n").flatMap(line => {
    const [mount, filesystem] = line.split(" - ");
    const path = mount?.split(" ")[4];
    return path && filesystem?.split(" ")[0] === "fuse.gocryptfs" && registered.has(decode(path)) ? [decode(path)] : [];
  });
}

export async function detachInheritedCustodyMounts(people: Person[]): Promise<number> {
  if (process.getuid?.() !== 0 || readlinkSync("/proc/self/ns/mnt") === readlinkSync("/proc/1/ns/mnt"))
    throw new Error("Custody detachment requires root in a separate private mount namespace");
  const run = async (args: string[]) => {
    const child = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { if (await child.exited !== 0) throw new Error("Inherited custody mount could not be detached safely"); }
    finally { clearTimeout(timer); }
  };
  // A distinct namespace alone may still propagate an unmount through shared mounts.
  await run(["mount", "--make-rprivate", "/"]);
  let detached = 0;
  for (const path of inheritedCustodyMounts(people)) {
    await run(["umount", "--lazy", "--", path]);
    detached++;
  }
  if (inheritedCustodyMounts(people).length) throw new Error("Inherited custody folder mounts remain");
  return detached;
}

export function custodyDiagnostic(message: string, stderr: string, key: string): string {
  const detail = stderr.replaceAll(key, "[redacted]").trim().slice(0, 4096);
  return detail ? `${message}: ${detail}` : message;
}

export class KenanMounts {
  private children = new Map<string, ReturnType<typeof Bun.spawn>>();
  constructor(private options: { userFor?: (person: Person) => string; forceOwner?: { uid: number; gid: number } } = {}) {}
  async mount(person: Person, key: string): Promise<CustodyResult> {
    if (!person.unlock) return { ok: true };
    const { cipherDir, mountpoint } = person.unlock;
    const existing = this.children.get(person.user);
    if (existing && existing.exitCode === null && await this.isMounted(mountpoint)) return { ok: true };
    if (await this.isMounted(mountpoint)) return { ok: false, status: 503, error: "A folder mount not owned by custody is present" };
    mkdirSync(mountpoint, { recursive: true, mode: 0o700 });
    const owner = this.options.userFor?.(person);
    if (owner && process.getuid!() !== 0) return { ok: false, status: 503, error: "Folder-owner mount helper requires its fixed privileged service" };
    const forced = this.options.forceOwner;
    const command = ["gocryptfs", "-fg", "-q", "-nosyslog", "-acl", "-allow_other",
      ...(forced ? ["-force_owner", `${forced.uid}:${forced.gid}`] : []), "--", cipherDir, mountpoint];
    const child = Bun.spawn(owner ? ["runuser", "-u", owner, "--", ...command] : command, { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    // Never put folder keys in argv, the environment, logs or durable plaintext files.
    child.stdin.write(`${key}\n`);
    child.stdin.end();
    const errors = new Response(child.stderr).text();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && child.exitCode === null) {
      if (await this.isMounted(mountpoint)) { this.children.set(person.user, child); return { ok: true }; }
      await Bun.sleep(20);
    }
    child.kill();
    await child.exited;
    const detail = await errors;
    return { ok: false, status: 403, error: custodyDiagnostic("Wrong key, or the folder could not mount", detail, key) };
  }
  private async isMounted(path: string) {
    const proc = Bun.spawn(["mountpoint", "-q", "--", path], { stdout: "ignore", stderr: "ignore" });
    return await proc.exited === 0;
  }
  async close() {
    for (const child of this.children.values()) child.kill();
    await Promise.all([...this.children.values()].map(child => child.exited));
    this.children.clear();
  }
}
