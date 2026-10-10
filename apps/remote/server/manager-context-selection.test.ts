import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Thread } from "pi-orchestrator/api";
import { reconcileThreadContextSelection } from "./manager-context-selection";
import { contextFilesPrompt, listContextFiles } from "./thread-context-files";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "manager-context-")); roots.push(root);
  const directory = join(root, "personal", "context"); mkdirSync(directory, { recursive: true });
  const agents = join(root, "personal", "AGENTS.md"); writeFileSync(agents, "WORKSPACE_INSTRUCTIONS_ALREADY_LOADED");
  for (const name of ["HARA.md", "KENAN.md", "NEBULANI.md", "README.md"]) writeFileSync(join(directory, name), `WHOLE_${name}`);
  const sources = { directory, agentsPaths: [agents] };
  let thread: Pick<Thread, "id" | "metadata"> = { id: "manager", metadata: { manager: true, profileId: "personal", contextFiles: ["HARA.md", "KENAN.md"] } };
  const changes: unknown[] = [];
  return { root, directory, agents, sources, changes, current: () => thread,
    select() { return reconcileThreadContextSelection(thread, sources, metadata => { changes.push(metadata); thread = { ...thread, metadata: { ...thread.metadata, ...metadata } }; return { ok: true, value: thread }; }); } };
}
test("existing manager selection is persisted as every offered identity and remains live for newly offered files", () => {
  const f = fixture(); const first = f.select(); expect(first.ok).toBe(true);
  if (!first.ok) throw new Error(first.error.message);
  expect(first.value).toEqual({ mode: "all", files: listContextFiles(f.sources).map(offer => offer.name) });
  expect(first.value.files).toContain("NEBULANI.md"); expect(first.value.files).toContain(f.agents);
  expect(f.current().metadata?.contextSelection).toBe("all");
  f.select(); expect(f.changes).toHaveLength(1);
  writeFileSync(join(f.directory, "NEW.md"), "NEW_DOCUMENT");
  const next = f.select(); expect(next.ok && next.value.files.includes("NEW.md")).toBe(true); expect(f.changes).toHaveLength(2);
  rmSync(join(f.directory, "README.md")); f.select(); expect(f.current().metadata?.contextFiles).not.toContain("README.md");
});
test("automatic assembly loads fresh content once per physical file without reinjecting SDK instruction files", () => {
  const f = fixture(); symlinkSync(join(f.directory, "NEBULANI.md"), join(f.directory, "ALIAS.md")); symlinkSync(f.agents, join(f.directory, "INSTRUCTIONS.md"));
  const selected = f.select(); if (!selected.ok) throw new Error(selected.error.message);
  let prompt = contextFilesPrompt(f.sources, selected.value.files, true);
  expect(prompt.match(/WHOLE_NEBULANI.md/g)).toHaveLength(1); expect(prompt).not.toContain("WORKSPACE_INSTRUCTIONS_ALREADY_LOADED");
  expect(prompt).toContain("automatically selects every context file");
  writeFileSync(join(f.directory, "HARA.md"), "CURRENT_EDIT_NOT_A_SNAPSHOT");
  prompt = contextFilesPrompt(f.sources, selected.value.files, true); expect(prompt).toContain("CURRENT_EDIT_NOT_A_SNAPSHOT"); expect(prompt).not.toContain("WHOLE_HARA.md");
});
test("ordinary threads remain manual and selection never expands beyond the person's current destination offers", () => {
  const f = fixture(); const otherDirectory = join(f.root, "work"); mkdirSync(otherDirectory); writeFileSync(join(otherDirectory, "WORK.md"), "WORK_PRIVATE");
  const manual = { ...f.current(), metadata: { manager: false, contextFiles: ["KENAN.md"] } };
  const selected = reconcileThreadContextSelection(manual, f.sources, () => { throw new Error("Ordinary threads must not be mutated"); });
  expect(selected).toEqual({ ok: true, value: { mode: "manual", files: ["KENAN.md"] } });
  const own = f.select(); expect(own.ok && own.value.files.includes("WORK.md")).toBe(false);
  expect(contextFilesPrompt(f.sources, ["KENAN.md"])).not.toContain("WHOLE_NEBULANI.md");
  const failure = reconcileThreadContextSelection(f.current(), f.sources, () => ({ ok: false, error: { code: "unavailable", message: "Owner write failed" } }));
  expect(failure.ok).toBe(true);
  const unpersisted = { ...f.current(), metadata: { manager: true } };
  expect(reconcileThreadContextSelection(unpersisted, f.sources, () => ({ ok: false, error: { code: "unavailable", message: "Owner write failed" } }))).toMatchObject({ ok: false });
});
