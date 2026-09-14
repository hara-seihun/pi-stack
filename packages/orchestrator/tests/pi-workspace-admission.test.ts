import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createWorkspaceAdmission, type CwdAdmission } from "../src/workspace-admission.js";
import { preparePiWorkspace, type PiWorkspaceExec } from "../src/cores/pi-workspace.js";
import type { PiNode } from "../src/cores/pi-types.js";

let directory: string;
let root: string;
let outside: string;
let admission: CwdAdmission;
let node: PiNode;

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "pi-workspace-admission-")));
  root = join(directory, "root");
  outside = join(directory, "outside");
  mkdirSync(root); mkdirSync(outside);
  const configured = createWorkspaceAdmission([{ id: "home", name: "Home", path: root }]);
  if (!configured.ok) throw new Error(configured.error.message);
  admission = configured.value;
  node = { id: "child", parentId: "root", name: "Child", cwd: root, state: "idle", busy: false,
    sessionFile: join(directory, "child.jsonl"), workspace: { root, repo: "fixture-repo" } };
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

test("managed checkout creation uses an admitted absolute pool and admits the resulting directory", async () => {
  const path = join(root, "pi-child-child");
  const execute = vi.fn<PiWorkspaceExec>(async (_command, args) => {
    if (args[0] === "create") mkdirSync(path);
    return { stdout: JSON.stringify({ path }) };
  });
  await preparePiWorkspace(node, admission, execute);
  expect(execute.mock.calls[0][1]).toEqual(["create", "--root", root, "--name", "pi-child-child", "--repo", "fixture-repo",
    "--owner", "child", "--mode", "writer", "--json"]);
  expect(node.cwd).toBe(path);
  expect(node.workspace!.path).toBe(path);
  await preparePiWorkspace(node, admission, execute);
  expect(execute.mock.calls[1][1]).toEqual(["heartbeat", "--path", path]);
});

test("workspace preparation cannot overwrite a malformed saved cwd", async () => {
  node.cwd = "sibyl";
  const execute = vi.fn<PiWorkspaceExec>();
  await expect(preparePiWorkspace(node, admission, execute)).rejects.toThrow("nodes[child].cwd: relative_cwd");
  expect(execute).not.toHaveBeenCalled();
  expect(node.cwd).toBe("sibyl");
  expect(node.workspace!.path).toBeUndefined();
});

test("relative, outside, and escaping pool roots are rejected before running agent-workspace", async () => {
  const escape = join(root, "escape");
  symlinkSync(outside, escape);
  const execute = vi.fn<PiWorkspaceExec>();
  for (const path of ["home", "sibyl", outside, escape]) {
    node.workspace!.root = path;
    await expect(preparePiWorkspace(node, admission, execute)).rejects.toThrow("workspace.root");
  }
  expect(execute).not.toHaveBeenCalled();
});

test("saved checkout paths must already be admitted directories", async () => {
  const escape = join(root, "escape");
  symlinkSync(outside, escape);
  const execute = vi.fn<PiWorkspaceExec>();
  for (const path of ["sibyl", outside, escape, join(root, "missing")]) {
    node.workspace!.path = path;
    await expect(preparePiWorkspace(node, admission, execute)).rejects.toThrow("workspace.path");
    expect(node.workspace!.path).toBe(path);
    expect(node.cwd).toBe(root);
  }
  expect(execute).not.toHaveBeenCalled();
});

test("an existing generated checkout cannot symlink outside the policy", async () => {
  symlinkSync(outside, join(root, "pi-child-child"));
  const execute = vi.fn<PiWorkspaceExec>();
  await expect(preparePiWorkspace(node, admission, execute)).rejects.toThrow("outside_workspace");
  expect(execute).not.toHaveBeenCalled();
});

test("creation results are checked again before changing saved workspace or cwd", async () => {
  const path = join(root, "pi-child-child");
  const execute = vi.fn<PiWorkspaceExec>(async () => {
    symlinkSync(outside, path);
    return { stdout: JSON.stringify({ path }) };
  });
  await expect(preparePiWorkspace(node, admission, execute)).rejects.toThrow("outside_workspace");
  expect(node.cwd).toBe(root);
  expect(node.workspace!.path).toBeUndefined();
});

test("a saved node id cannot turn a planned checkout into a parent traversal", async () => {
  node.id = "../../outside";
  const execute = vi.fn<PiWorkspaceExec>();
  await expect(preparePiWorkspace(node, admission, execute)).rejects.toThrow("Invalid managed workspace node id");
  expect(execute).not.toHaveBeenCalled();
});
