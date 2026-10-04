import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectRetainedCustodyKeys } from "./one-kenan-retained-keys";
import { KenanKeys } from "./one-kenan-keys";
import type { Person } from "./persons";

test("failed gocryptfs preserves the mount reason while never returning the supplied key", async () => {
  const root = mkdtempSync(join(tmpdir(), "mount-diagnostics-"));
  const previous = process.env.PATH;
  try {
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin/mountpoint"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(join(root, "bin/gocryptfs"), '#!/bin/sh\nread -r key\nprintf "fusermount3: failed mntpnt match; input %s\\n" "$key" >&2\nexit 1\n', { mode: 0o755 });
    const person: Person = { version: 1, user: "alice", displayName: "Alice", port: 19881,
      unlock: { cipherDir: join(root, "cipher"), mountpoint: join(root, "private") }, environment: {} };
    const child = Bun.spawnSync([process.execPath, "-e", `
      const { KenanMounts } = await import(${JSON.stringify(join(import.meta.dir, "one-kenan-mounts.ts"))});
      const mounts = new KenanMounts();
      console.log(JSON.stringify(await mounts.mount(${JSON.stringify(person)}, "fixture-secret-never-log")));
      await mounts.close();
    `], { env: { ...process.env, PATH: `${root}/bin:${previous}` }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed mntpnt match");
    expect(JSON.stringify(result)).not.toContain("fixture-secret-never-log");
    expect(JSON.stringify(result)).toContain("[redacted]");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("retained-key rejection identifies shared-store failure, not a need for another login", async () => {
  const root = mkdtempSync(join(tmpdir(), "retained-diagnostics-"));
  const people: Person[] = ["alice", "bob"].map(user => ({ version: 1, user, displayName: user, port: 19881,
    unlock: { cipherDir: join(root, user, "cipher"), mountpoint: join(root, user, "private") }, environment: {} }));
  const buffers: Buffer[] = [];
  try {
    const keys = new KenanKeys(join(root, "keys.json"), people, async () => ({ ok: true }),
      async () => ({ ok: false, status: 503, error: "Shared storage: fusermount3 failed mntpnt match" }));
    const result = await collectRetainedCustodyKeys(keys, people, root, (_dir, person) => {
      const key = Buffer.from(`${person.user}-fixture-secret`); buffers.push(key); return key;
    });
    expect(result.collected).toEqual([]);
    expect(result.rejected).toEqual(people.map(person => ({ person: person.user, ok: false, status: 503,
      error: "Shared storage: fusermount3 failed mntpnt match" })));
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(buffers.every(key => key.every(byte => byte === 0))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
