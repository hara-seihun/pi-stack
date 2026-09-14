import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { CwdAdmission } from "../workspace-admission.js";
import { requirePiCwd } from "./pi-cwd.js";
import type { PiNode } from "./pi-types.js";

const exec = promisify(execFile);
export type PiWorkspaceExec = (command: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;

export function planPiWorkspace(node: PiNode, admission: CwdAdmission): { root: string; path: string; create: boolean } | undefined {
  if (!node.workspace) return;
  const root = requirePiCwd(admission, node.workspace.root, `nodes[${node.id}].workspace.root`);
  if (node.workspace.path !== undefined) return {
    root, path: requirePiCwd(admission, node.workspace.path, `nodes[${node.id}].workspace.path`), create: false,
  };
  const name = `pi-child-${node.id}`;
  if (basename(name) !== name) throw new Error(`Invalid managed workspace node id: ${node.id}`);
  const path = join(root, name);
  return lstatSync(path, { throwIfNoEntry: false })
    ? { root, path: requirePiCwd(admission, path, `nodes[${node.id}].workspace checkout`), create: false }
    : { root, path, create: true };
}

export async function preparePiWorkspace(node: PiNode, admission: CwdAdmission, execute: PiWorkspaceExec = exec): Promise<void> {
  const cwd = requirePiCwd(admission, node.cwd, `nodes[${node.id}].cwd`);
  const plan = planPiWorkspace(node, admission);
  if (!plan) { node.cwd = cwd; return; }
  if (plan.create) {
    const { stdout } = await execute("agent-workspace", ["create", "--root", plan.root,
      "--name", `pi-child-${node.id}`, "--repo", node.workspace!.repo, "--owner", node.id, "--mode", "writer", "--json"], { timeout: 30_000 });
    const created = JSON.parse(stdout);
    if (created.path !== plan.path) throw new Error(`Unexpected child workspace path: ${created.path}`);
  } else {
    await execute("agent-workspace", ["heartbeat", "--path", plan.path], { timeout: 30_000 });
  }
  const path = requirePiCwd(admission, plan.path, `nodes[${node.id}].workspace checkout`);
  node.workspace!.path = path;
  node.cwd = path;
}

export async function heartbeatPiWorkspace(node: PiNode, admission: CwdAdmission): Promise<void> {
  if (node.workspace?.path) {
    const path = requirePiCwd(admission, node.workspace.path, `nodes[${node.id}].workspace.path`);
    await exec("agent-workspace", ["heartbeat", "--path", path], { timeout: 15_000 });
  }
}
