import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceAdmission, type WorkspaceAdmission, type WorkspaceAdmissionResult } from "../src/workspace-admission.js";

let base: string;
let root: string;
let outside: string;
let admission: WorkspaceAdmission;

function value<T>(result: WorkspaceAdmissionResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "workspace-admission-")));
  root = join(base, "root");
  outside = join(base, "root-neighbor");
  mkdirSync(join(root, "nested"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "file"), "not a directory");
  admission = value(createWorkspaceAdmission([{ id: "home", name: "Home", path: root }]));
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

test("configured ids resolve to absolute roots, never to a process-relative directory", () => {
  expect(value(admission.resolve("home"))).toEqual({
    cwd: root, workspace: { id: "home", name: "Home", path: root },
  });
  const sibyl = value(createWorkspaceAdmission([{ id: "sibyl", name: "Sibyl", path: root }]));
  expect(value(sibyl.resolve("sibyl")).cwd).toBe(root);
  for (const id of ["sibyl", "nested", ".", "..", "./home", "../root"]) {
    expect(admission.resolve(id)).toMatchObject({ ok: false, error: { code: "unknown_workspace_id", workspaceId: id } });
  }
  for (const id of [undefined, null, 123, {}, "", " ", "bad\0path"]) {
    expect(admission.resolve(id)).toMatchObject({ ok: false, error: { code: "invalid_workspace_id" } });
  }
});

test("absolute roots and descendants are admitted, but ancestors and prefix siblings are not", () => {
  expect(value(admission.resolve(root)).cwd).toBe(root);
  expect(value(admission.resolve(join(root, "nested"))).cwd).toBe(join(root, "nested"));
  for (const cwd of [base, outside, `${root}/../root-neighbor`]) {
    expect(admission.resolve(cwd)).toMatchObject({ ok: false, error: { code: "outside_workspace" } });
  }
  expect(value(createWorkspaceAdmission([])).resolve(root)).toMatchObject({ ok: false, error: { code: "outside_workspace" } });
});

test("symlink escapes are rejected and internal links return canonical cwd", () => {
  symlinkSync(outside, join(root, "escape"));
  symlinkSync(join(root, "nested"), join(root, "inside"));
  expect(admission.resolve(join(root, "escape"))).toMatchObject({ ok: false, error: { code: "outside_workspace", path: outside } });
  expect(value(admission.resolve(join(root, "inside"))).cwd).toBe(join(root, "nested"));
  rmSync(join(root, "inside"));
  symlinkSync(outside, join(root, "inside"));
  expect(admission.resolve(join(root, "inside"))).toMatchObject({ ok: false, error: { code: "outside_workspace" } });
});

test("each admission checks that cwd still exists and is a directory", () => {
  expect(admission.resolve(join(root, "file"))).toMatchObject({ ok: false, error: { code: "cwd_not_directory" } });
  expect(admission.resolve(join(root, "missing"))).toMatchObject({ ok: false, error: { code: "cwd_unavailable", causeCode: "ENOENT" } });
  symlinkSync(join(root, "missing"), join(root, "broken"));
  expect(admission.resolve(join(root, "broken"))).toMatchObject({ ok: false, error: { code: "cwd_unavailable" } });
  rmSync(root, { recursive: true });
  expect(admission.resolve("home")).toMatchObject({ ok: false, error: { code: "cwd_unavailable" } });
  writeFileSync(root, "now a file");
  expect(admission.resolve("home")).toMatchObject({ ok: false, error: { code: "cwd_not_directory" } });
});

test("absolute configuration links are canonicalized, while later root replacement cannot expand policy", () => {
  const alias = join(base, "alias");
  symlinkSync(root, alias);
  const configured = value(createWorkspaceAdmission([{ id: "linked", name: "Linked", path: alias }]));
  expect(configured.workspaces.get("linked")?.path).toBe(root);
  expect(value(configured.resolve("linked")).cwd).toBe(root);
  expect(value(configured.resolve(join(alias, "nested"))).cwd).toBe(join(root, "nested"));
  renameSync(root, join(base, "moved"));
  symlinkSync(outside, root);
  expect(configured.resolve("linked")).toMatchObject({ ok: false, error: { code: "outside_workspace" } });
  expect(configured.resolve(root)).toMatchObject({ ok: false, error: { code: "outside_workspace" } });
});

test("overlapping roots choose the most specific workspace for absolute cwd, preserving explicit ids", () => {
  const nested = join(root, "nested");
  const configured = value(createWorkspaceAdmission([
    { id: "home", name: "Home", path: root },
    { id: "project", name: "Project", path: nested },
  ]));
  expect(value(configured.resolve(nested)).workspace.id).toBe("project");
  expect(value(configured.resolve("home")).workspace.id).toBe("home");
  expect(value(configured.resolve("project")).cwd).toBe(nested);
});

test("configuration rejects relative roots before filesystem resolution", () => {
  for (const path of [".", "sibyl", "./sibyl", "../sibyl", "~/sibyl"]) {
    expect(createWorkspaceAdmission([{ id: "sibyl", name: "Sibyl", path }])).toMatchObject({
      ok: false, error: { code: "relative_workspace_root", path, workspaceId: "sibyl" },
    });
  }
});

test("configuration fails on missing and non-directory roots rather than silently dropping them", () => {
  expect(createWorkspaceAdmission([{ id: "missing", name: "Missing", path: join(base, "missing") }])).toMatchObject({
    ok: false, error: { code: "workspace_root_unavailable", causeCode: "ENOENT" },
  });
  expect(createWorkspaceAdmission([{ id: "file", name: "File", path: join(root, "file") }])).toMatchObject({
    ok: false, error: { code: "workspace_root_not_directory" },
  });
});

test("configuration has a typed failure for malformed entries and duplicate ids", () => {
  for (const config of [null, {}, "[]", [null], [{ id: "home", path: root }], [{ id: "", name: "Home", path: root }],
    [{ id: "home", name: "Home", path: "bad\0path" }]]) {
    expect(createWorkspaceAdmission(config)).toMatchObject({ ok: false, error: { code: "invalid_workspace_config" } });
  }
  expect(createWorkspaceAdmission([
    { id: "home", name: "Home", path: root },
    { id: "home", name: "Duplicate", path: outside },
  ])).toMatchObject({ ok: false, error: { code: "duplicate_workspace_id", workspaceId: "home" } });
});
