import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextFilesPrompt, listContextFiles, measureContextFile, selectContextFiles } from "./thread-context-files";

function folder() {
  const root = mkdtempSync(join(tmpdir(), "pi-remote-context-"));
  const context = join(root, "context");
  mkdirSync(join(context, "reference"), { recursive: true });
  writeFileSync(join(context, "HARA.md"), "# Hara\n\nWho she is.\n");
  writeFileSync(join(root, "NEBULANI.md"), "# Nebulani\n\nCanon.\n");
  symlinkSync(join(root, "NEBULANI.md"), join(context, "NEBULANI.md"));
  writeFileSync(join(context, "reference", "grants.md"), "not offered");
  writeFileSync(join(context, "notes.txt"), "not markdown");
  return { root, context };
}

test("a context folder offers its top-level Markdown files, following symlinks, each with a token count", () => {
  const { context } = folder();
  const offers = listContextFiles(context);
  expect(offers.map((offer) => offer.name)).toEqual(["HARA.md", "NEBULANI.md"]);
  for (const offer of offers) {
    expect(offer.tokens).toBeGreaterThan(0);
    expect(offer.bytes).toBeGreaterThan(0);
  }
  expect(listContextFiles(join(context, "missing"))).toEqual([]);
});

test("measurements follow the file's bytes", () => {
  const { context } = folder();
  const path = join(context, "HARA.md");
  const before = measureContextFile(path)!;
  writeFileSync(path, "# Hara\n\nWho she is, what is true now, and what she has ruled, at some length.\n");
  const after = measureContextFile(path)!;
  expect(after.tokens).toBeGreaterThan(before.tokens);
  expect(measureContextFile(join(context, "reference"))).toBeNull();
});

test("a thread may choose only offered files, and a destination without a folder accepts none", () => {
  const { context } = folder();
  expect(selectContextFiles(context, undefined)).toEqual({ ok: true, value: [] });
  expect(selectContextFiles(context, ["NEBULANI.md", "HARA.md", "HARA.md"])).toEqual({ ok: true, value: ["NEBULANI.md", "HARA.md"] });
  expect(selectContextFiles(context, ["reference/grants.md"])).toMatchObject({ ok: false });
  expect(selectContextFiles(context, ["../NEBULANI.md"])).toMatchObject({ ok: false });
  expect(selectContextFiles(context, "HARA.md")).toMatchObject({ ok: false });
  expect(selectContextFiles(null, [])).toEqual({ ok: true, value: [] });
  expect(selectContextFiles(null, ["HARA.md"])).toMatchObject({ ok: false });
});

test("the prompt carries each chosen file whole and names one that has gone missing", () => {
  const { context } = folder();
  expect(contextFilesPrompt(context, [])).toBe("");
  const prompt = contextFilesPrompt(context, ["HARA.md", "gone.md"]);
  expect(prompt).toContain(`## ${join(context, "HARA.md")}\n\n# Hara\n\nWho she is.`);
  expect(prompt).toContain(`## ${join(context, "gone.md")}\n\nThis chosen file could not be read (ENOENT)`);
  expect(prompt).not.toContain("NEBULANI");
});
