import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PiNode } from "./pi-types.js";

const exec = promisify(execFile);
export async function preparePiWorkspace(node: PiNode): Promise<void> {
  if (!node.workspace) return;
  const name = `pi-child-${node.id}`;
  const path = node.workspace.path ?? join(node.workspace.root, name);
  if (existsSync(path)) {
    await exec("agent-workspace", ["heartbeat", "--path", path], { timeout: 30_000 });
  } else {
    const { stdout } = await exec("agent-workspace", ["create", "--root", node.workspace.root,
      "--name", name, "--repo", node.workspace.repo, "--owner", node.id, "--mode", "writer", "--json"], { timeout: 30_000 });
    const created = JSON.parse(stdout);
    if (created.path !== path) throw new Error(`Unexpected child workspace path: ${created.path}`);
  }
  node.workspace.path = path;
  node.cwd = path;
}

export async function heartbeatPiWorkspace(node: PiNode): Promise<void> {
  if (node.workspace?.path) await exec("agent-workspace", ["heartbeat", "--path", node.workspace.path], { timeout: 15_000 });
}
