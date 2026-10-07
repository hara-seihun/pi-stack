import { expect, test } from "vitest";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { custodyPrivateFileMode, custodyReplaceFileSync } from "../shared-custody.js";
import { writePiSessionFile } from "./pi-session-file.js";

test("session and custody atomic replacements retain observer access without broadening private files", () => {
  const root = mkdtempSync(join(tmpdir(), "session-permissions-"));
  const prior = process.env.PI_REMOTE_ROOMS_RUNTIME;
  const umask = process.umask(0o077);
  try {
    for (const replace of [writePiSessionFile, custodyReplaceFileSync]) {
      const path = join(root, crypto.randomUUID());
      writeFileSync(path, "fixture"); chmodSync(path, 0o640);
      replace(path, "replacement");
      expect(statSync(path).mode & 0o777).toBe(0o640);
      chmodSync(path, 0o600); replace(path, "private");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(custodyPrivateFileMode(join(root, "new-private"), {})).toBe(0o600);
      process.env.PI_REMOTE_ROOMS_RUNTIME = "1";
      const room = join(root, crypto.randomUUID()); replace(room, "room");
      expect(statSync(room).mode & 0o777).toBe(0o640);
      delete process.env.PI_REMOTE_ROOMS_RUNTIME;
    }
  } finally {
    process.umask(umask);
    if (prior === undefined) delete process.env.PI_REMOTE_ROOMS_RUNTIME;
    else process.env.PI_REMOTE_ROOMS_RUNTIME = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("room atomic replacement retains the inherited named read-only observer ACL", () => {
  const root = mkdtempSync(join(tmpdir(), "session-observer-acl-"));
  try {
    const grant = spawnSync("setfacl", ["-m", "u:65010:r-x,d:u:65010:r-x", root], { timeout: 1000 });
    expect(grant.status).toBe(0);
    for (const replace of [writePiSessionFile, custodyReplaceFileSync]) {
      const path = join(root, crypto.randomUUID());
      writeFileSync(path, "fixture", { mode: 0o640 });
      replace(path, "replacement");
      const acl = spawnSync("getfacl", ["-cpn", path], { encoding: "utf8", timeout: 1000 });
      expect(acl.status).toBe(0);
      expect(acl.stdout).toContain("user:65010:r-x\t#effective:r--");
      expect(acl.stdout).not.toContain("#effective:rw");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
