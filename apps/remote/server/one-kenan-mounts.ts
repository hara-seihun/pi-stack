import { mkdirSync } from "node:fs";
import type { Person } from "./persons";
import type { CustodyResult } from "./one-kenan-keys";

export class KenanMounts {
  private children = new Map<string, ReturnType<typeof Bun.spawn>>();
  async mount(person: Person, key: string): Promise<CustodyResult> {
    if (!person.unlock) return { ok: true };
    const { cipherDir, mountpoint } = person.unlock;
    const existing = this.children.get(person.user);
    if (existing && existing.exitCode === null && await this.isMounted(mountpoint)) return { ok: true };
    if (await this.isMounted(mountpoint)) return { ok: false, status: 503, error: "A folder mount not owned by custody is present" };
    mkdirSync(mountpoint, { recursive: true, mode: 0o700 });
    const child = Bun.spawn(["gocryptfs", "-fg", "-q", "-nosyslog", "-acl", "-force_owner", `${process.getuid!()}:${process.getgid!()}`, "--", cipherDir, mountpoint], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
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
    await errors;
    return { ok: false, status: 403, error: "Wrong key, or the folder could not mount" };
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
