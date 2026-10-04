import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { contextFilesPrompt, listContextFiles, measureContextFile, selectContextFiles, watchContextFiles, type ContextFileSources } from "./thread-context-files";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function folder() {
  const root = mkdtempSync(join(tmpdir(), "pi-remote-context-"));
  roots.push(root);
  const home = join(root, "home");
  const workspace = join(home, "personal");
  const context = join(workspace, "context");
  mkdirSync(join(context, "reference"), { recursive: true });
  writeFileSync(join(context, "HARA.md"), "# Hara\n\nWho she is.\n");
  writeFileSync(join(root, "NEBULANI.md"), "# Nebulani\n\nCanon.\n");
  symlinkSync(join(root, "NEBULANI.md"), join(context, "NEBULANI.md"));
  symlinkSync(join(root, "missing.md"), join(context, "broken.md"));
  writeFileSync(join(context, "reference", "grants.md"), "not offered");
  writeFileSync(join(context, "notes.txt"), "not markdown");
  const workspaceAgents = join(workspace, "AGENTS.md");
  const homeAgents = join(home, "AGENTS.md");
  const sources: ContextFileSources = { directory: context, agentsPaths: [workspaceAgents, homeAgents] };
  return { root, home, workspace, context, workspaceAgents, homeAgents, sources };
}

test("a context folder offers readable top-level Markdown, following symlinks, each with a token count", () => {
  const { context, sources } = folder();
  const offers = listContextFiles(sources);
  expect(offers.map((offer) => offer.name)).toEqual(["HARA.md", "NEBULANI.md"]);
  for (const offer of offers) {
    expect(offer.tokens).toBeGreaterThan(0);
    expect(offer.bytes).toBeGreaterThan(0);
  }
  expect(listContextFiles({ directory: join(context, "missing") })).toEqual([]);
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

test("a thread may choose only offered identities, and a destination without sources accepts none", () => {
  const { sources, root } = folder();
  expect(selectContextFiles(sources, undefined)).toEqual({ ok: true, value: [] });
  expect(selectContextFiles(sources, ["NEBULANI.md", "HARA.md", "HARA.md"])).toEqual({ ok: true, value: ["NEBULANI.md", "HARA.md"] });
  for (const invalid of ["reference/grants.md", "../NEBULANI.md", join(root, "NEBULANI.md")]) {
    expect(selectContextFiles(sources, [invalid])).toMatchObject({ ok: false });
    expect(contextFilesPrompt(sources, [invalid])).not.toContain("# Nebulani");
  }
  expect(selectContextFiles(sources, "HARA.md")).toMatchObject({ ok: false });
  expect(selectContextFiles(null, [])).toEqual({ ok: true, value: [] });
  expect(selectContextFiles(null, ["HARA.md"])).toMatchObject({ ok: false });
});

test("the prompt carries only chosen files whole and fresh, including trailing bytes and missing-file notices", () => {
  const { context, sources } = folder();
  expect(contextFilesPrompt(sources, [])).toBe("");
  const text = "# Hara\n\nUpdated, including trailing whitespace.  \n\n";
  writeFileSync(join(context, "HARA.md"), text);
  const prompt = contextFilesPrompt(sources, ["HARA.md", "gone.md"]);
  expect(prompt).toContain(`## ${join(context, "HARA.md")}\n\n${text}`);
  expect(prompt).toContain(`## ${join(context, "gone.md")}\n\nThis chosen file could not be read (ENOENT)`);
  expect(prompt).not.toContain("NEBULANI");
  expect(contextFilesPrompt(null, ["HARA.md"])).toContain("no longer available");
});

test("workspace AGENTS is offered beside Markdown with a friendly label and distinct identity", () => {
  const { sources, workspaceAgents, homeAgents, context } = folder();
  const text = "# Workspace instructions\n\nChosen explicitly.\n";
  writeFileSync(workspaceAgents, text);
  writeFileSync(homeAgents, "home instructions must not be selected");
  writeFileSync(join(context, "AGENTS.md"), "different context-folder document");
  const offers = listContextFiles(sources);
  expect(offers.map(offer => offer.name)).toEqual(["AGENTS.md", "HARA.md", "NEBULANI.md", workspaceAgents]);
  expect(offers.at(-1)).toEqual({ name: workspaceAgents, label: "AGENTS.md", tokens: countTokens(text), bytes: Buffer.byteLength(text) });
  expect(selectContextFiles(sources, [workspaceAgents])).toEqual({ ok: true, value: [workspaceAgents] });
  expect(selectContextFiles(sources, [homeAgents])).toMatchObject({ ok: false });
  expect(contextFilesPrompt(sources, [])).toBe("");
  expect(contextFilesPrompt(sources, [workspaceAgents])).toContain(text);
  expect(contextFilesPrompt(sources, [workspaceAgents])).not.toContain("different context-folder");
  writeFileSync(workspaceAgents, "# New instructions\n\nLive next turn.\n");
  expect(contextFilesPrompt(sources, [workspaceAgents])).toContain("Live next turn.");
});

test("AGENTS offers work without a context folder, follow symlinks, and use home only when workspace AGENTS is absent", () => {
  const { sources, context, workspaceAgents, homeAgents } = folder();
  rmSync(context, { recursive: true });
  writeFileSync(homeAgents, "# Home instructions\n");
  expect(listContextFiles(sources).map(offer => offer.name)).toEqual([homeAgents]);
  symlinkSync(homeAgents, workspaceAgents);
  expect(listContextFiles(sources).map(offer => offer.name)).toEqual([workspaceAgents]);
  expect(listContextFiles(sources)[0].tokens).toBe(countTokens("# Home instructions\n"));
});

test("a selected AGENTS path never switches source when workspace files appear or disappear", () => {
  const { sources, workspaceAgents, homeAgents } = folder();
  writeFileSync(homeAgents, "home content");
  expect(selectContextFiles(sources, [homeAgents])).toMatchObject({ ok: true });
  writeFileSync(workspaceAgents, "workspace content");
  expect(contextFilesPrompt(sources, [homeAgents])).toContain("home content");
  expect(contextFilesPrompt(sources, [homeAgents])).not.toContain("workspace content");
  expect(selectContextFiles(sources, [workspaceAgents])).toMatchObject({ ok: true });
  rmSync(workspaceAgents);
  expect(listContextFiles(sources).map(offer => offer.name)).toContain(homeAgents);
  const missing = contextFilesPrompt(sources, [workspaceAgents]);
  expect(missing).toContain("could not be read (ENOENT)");
  expect(missing).not.toContain("home content");
});

test("unreadable files are skipped even after measurement and do not broaden instruction-file access", () => {
  const { sources, context, workspaceAgents, homeAgents, workspace } = folder();
  writeFileSync(workspaceAgents, "workspace instructions");
  writeFileSync(homeAgents, "home instructions");
  expect(listContextFiles(sources).map(offer => offer.name)).toContain(workspaceAgents);
  chmodSync(workspaceAgents, 0);
  chmodSync(join(context, "HARA.md"), 0);
  try {
    expect(listContextFiles(sources).map(offer => offer.name)).toEqual(["NEBULANI.md"]);
    expect(contextFilesPrompt(sources, [workspaceAgents])).toContain("could not be read (EACCES)");
    chmodSync(workspace, 0);
    expect(listContextFiles(sources)).toEqual([]);
  } finally {
    chmodSync(workspace, 0o700);
    chmodSync(workspaceAgents, 0o600);
    chmodSync(join(context, "HARA.md"), 0o600);
  }
});

test("a non-file workspace AGENTS is skipped rather than replaced by home", () => {
  const { sources, workspaceAgents, homeAgents } = folder();
  mkdirSync(workspaceAgents);
  writeFileSync(homeAgents, "home instructions");
  expect(listContextFiles(sources).map(offer => offer.name)).toEqual(["HARA.md", "NEBULANI.md"]);
});

test("watch checks load a destination's configured context files, else its whole context folder, and none without one", () => {
  const { context, sources } = folder();
  expect(watchContextFiles(undefined, context)).toEqual(["HARA.md", "NEBULANI.md"]);
  expect(watchContextFiles(["HARA.md"], context)).toEqual(["HARA.md"]);
  expect(watchContextFiles([], context)).toEqual([]);
  expect(watchContextFiles(["HARA.md"], undefined)).toEqual([]);
  const prompt = contextFilesPrompt(sources, watchContextFiles(["HARA.md"], context));
  expect(prompt).toContain("# Context files chosen for this thread");
  expect(prompt).toContain("Who she is.");
  expect(prompt).not.toContain("# Nebulani");
});
