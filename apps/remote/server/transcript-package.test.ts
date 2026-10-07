import { test, expect } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("transcript presentation builds in a standalone Remote release", async () => {
  const source = dirname(fileURLToPath(import.meta.url));
  const staged = await mkdtemp(join(tmpdir(), "remote-transcript-package-"));
  try {
    await Promise.all([
      cp(source, join(staged, "server"), { recursive: true }),
      cp(resolve(source, "../shared"), join(staged, "shared"), { recursive: true }),
      mkdir(join(staged, "node_modules")),
    ]);
    await symlink(resolve(source, "../../../packages/orchestrator"), join(staged, "node_modules/pi-orchestrator"));
    const result = await Bun.build({ entrypoints: [join(staged, "server/transcript-items.ts")], target: "bun" });
    expect(result.logs.filter(log => log.level === "error").map(log => log.message)).toEqual([]);
    expect(result.success).toBe(true);
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
});
