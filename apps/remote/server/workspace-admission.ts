import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

export interface ConfiguredWorkspace {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export type WorkspaceAdmissionErrorCode =
  | "invalid_workspace_config"
  | "duplicate_workspace_id"
  | "relative_workspace_root"
  | "workspace_root_unavailable"
  | "workspace_root_not_directory"
  | "invalid_workspace_id"
  | "unknown_workspace_id"
  | "cwd_unavailable"
  | "cwd_not_directory"
  | "outside_workspace";

export interface WorkspaceAdmissionError {
  code: WorkspaceAdmissionErrorCode;
  message: string;
  workspaceId?: string;
  path?: string;
  causeCode?: string;
}

export type WorkspaceAdmissionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: WorkspaceAdmissionError };

export interface AdmittedWorkspace {
  cwd: string;
  workspace: ConfiguredWorkspace;
}

export interface WorkspaceAdmission {
  readonly workspaces: ReadonlyMap<string, ConfiguredWorkspace>;
  resolve(workspaceId: unknown): WorkspaceAdmissionResult<AdmittedWorkspace>;
}

function directory(path: string, root: boolean, workspaceId?: string): WorkspaceAdmissionResult<string> {
  try {
    // Resolve before checking containment; lexical prefixes do not constrain symlink targets.
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) return { ok: false, error: {
      code: root ? "workspace_root_not_directory" : "cwd_not_directory",
      message: `${root ? "Workspace root" : "Session cwd"} is not a directory: ${path}`,
      path, workspaceId,
    } };
    return { ok: true, value: canonical };
  } catch (cause) {
    return { ok: false, error: {
      code: root ? "workspace_root_unavailable" : "cwd_unavailable",
      message: `${root ? "Workspace root" : "Session cwd"} cannot be opened: ${path}`,
      path, workspaceId,
      causeCode: (cause as NodeJS.ErrnoException).code,
    } };
  }
}

function contains(root: string, cwd: string): boolean {
  const child = relative(root, cwd);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

export function createWorkspaceAdmission(definitions: unknown): WorkspaceAdmissionResult<WorkspaceAdmission> {
  if (!Array.isArray(definitions)) return { ok: false, error: {
    code: "invalid_workspace_config", message: "Workspace configuration must be an array of { id, name, path } entries",
  } };
  const workspaces = new Map<string, ConfiguredWorkspace>();
  for (const definition of definitions) {
    if (!definition || typeof definition !== "object"
      || typeof definition.id !== "string" || !definition.id.trim()
      || typeof definition.name !== "string" || !definition.name.trim()
      || typeof definition.path !== "string" || !definition.path || definition.path.includes("\0")) {
      return { ok: false, error: {
        code: "invalid_workspace_config", message: "Each workspace needs a nonempty id, name, and directory path",
      } };
    }
    const { id, name, path } = definition;
    if (workspaces.has(id)) return { ok: false, error: {
      code: "duplicate_workspace_id", message: `Workspace id is configured more than once: ${id}`, workspaceId: id,
    } };
    if (!isAbsolute(path)) return { ok: false, error: {
      code: "relative_workspace_root", message: `Workspace root must be absolute: ${path}`, workspaceId: id, path,
    } };
    const root = directory(path, true, id);
    if (!root.ok) return root;
    workspaces.set(id, Object.freeze({ id, name, path: root.value }));
  }
  const roots = [...workspaces.values()].sort((a, b) => b.path.length - a.path.length);
  return { ok: true, value: {
    workspaces,
    resolve(workspaceId): WorkspaceAdmissionResult<AdmittedWorkspace> {
      if (typeof workspaceId !== "string" || !workspaceId.trim() || workspaceId.includes("\0")) {
        return { ok: false, error: { code: "invalid_workspace_id", message: "A configured workspace id or absolute cwd is required" } };
      }
      const preset = workspaces.get(workspaceId);
      if (!preset && !isAbsolute(workspaceId)) return { ok: false, error: {
        code: "unknown_workspace_id", message: `Unknown workspace id: ${workspaceId}. Choose a configured workspace or an absolute cwd within one.`, workspaceId,
      } };
      const result = directory(preset?.path ?? workspaceId, false, workspaceId);
      if (!result.ok) return result;
      const cwd = result.value;
      // Keep the admitted roots fixed. Replacing a root with a symlink must not expand policy.
      const workspace = preset ? (contains(preset.path, cwd) ? preset : undefined)
        : roots.find(root => contains(root.path, cwd));
      if (!workspace) return { ok: false, error: {
        code: "outside_workspace", message: `Session cwd is outside configured workspace roots: ${cwd}`, workspaceId, path: cwd,
      } };
      return { ok: true, value: { cwd, workspace } };
    },
  } };
}
