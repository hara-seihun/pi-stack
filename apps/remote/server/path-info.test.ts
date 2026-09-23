import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPath } from "./files";

test("path inspection distinguishes files, folders and symlink targets without treating failures as files", () => {
  const root = mkdtempSync(join(tmpdir(), "remote-path-info-"));
  try {
    const path = join(root, "note.txt");
    writeFileSync(path, "note");
    symlinkSync(path, join(root, "note-link"));
    symlinkSync(root, join(root, "folder-link"));
    expect(inspectPath(path).kind).toBe("file");
    expect(inspectPath(root).kind).toBe("directory");
    expect(inspectPath(join(root, "note-link")).kind).toBe("file");
    expect(inspectPath(join(root, "folder-link")).kind).toBe("directory");
    expect(() => inspectPath(join(root, "missing"))).toThrow();
    expect(() => inspectPath("relative")).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
