import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const marker = "// PiStack per-shell descendant ownership\n";
const here = dirname(fileURLToPath(import.meta.url));
const exports = "spawnOwnedShell, cancelOwnedShell, releaseOwnedShell, shellOwnershipResult";

function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Pinned Bash cancellation anchor changed: ${before.slice(0, 100)}`);
  return source.replace(before, after);
}

function sdkShell(source) {
  source = replace(source, "export function killProcessTree(pid) {", "export function killProcessTree(pid) {\n    if (cancelOwnedShell(pid)) return;");
  return replace(source, "export function untrackDetachedChildPid(pid) {", "export function untrackDetachedChildPid(pid) {\n    releaseOwnedShell(pid);");
}

function sdkTool(source) {
  source = replace(source, "const child = spawn(shellConfig.shell,", "const child = spawnOwnedShell(shellConfig.shell,");
  return replace(source, "const exitCode = await waitForChildProcess(child);", `const exitCode = await waitForChildProcess(child);
                const ownership = await shellOwnershipResult(child);
                if (!ownership.ok) throw Object.assign(new Error(ownership.error), { code: "shell_cleanup_failed" });`);
}

function sdkExecutor(source) {
  return replace(source, "    catch (err) {", '    catch (err) {\n        if (err?.code === "shell_cleanup_failed") throw err;');
}

function harness(source) {
  source = replace(source, "function killProcessTree(pid) {", "function killProcessTree(pid) {\n    if (cancelOwnedShell(pid)) return;");
  source = replace(source, "child = spawn(shellConfig.value.shell,", "child = spawnOwnedShell(shellConfig.value.shell,");
  source = replace(source, "this.activeChildPids.delete(child.pid);", "this.activeChildPids.delete(child.pid);\n                if (child?.pid) releaseOwnedShell(child.pid);");
  return replace(source, "                if (callbackError) {\n                    settle(err(callbackError));", `                const ownership = await shellOwnershipResult(child);
                if (!ownership.ok) {
                    settle(err(new ExecutionError("unknown", ownership.error)));
                    return;
                }
                if (callbackError) {
                    settle(err(callbackError));`);
}

export function patchBashCancellationCopies(nodeModules) {
  const coding = join(nodeModules, "@earendil-works/pi-coding-agent/dist");
  const core = join(nodeModules, "@earendil-works/pi-agent-core/dist");
  const pending = new Map();
  const apply = (path, patch, relative) => {
    const source = readFileSync(path, "utf8");
    pending.set(path, source.startsWith(marker) ? source : marker + `import { ${exports} } from "${relative}/pi-shell-owner.mjs";\n` + patch(source));
  };
  apply(join(coding, "utils/shell.js"), sdkShell, "..");
  apply(join(coding, "core/tools/bash.js"), sdkTool, "../..");
  apply(join(coding, "core/bash-executor.js"), sdkExecutor, "..");
  apply(join(core, "harness/env/nodejs.js"), harness, "../..");
  apply(join(core, "harness/utils/shell-output.js"), source => replace(source,
    'result.error.code === "aborted" || context.abortSignal?.aborted',
    'result.error.code === "aborted"'), "../..");
  for (const base of [coding, core]) for (const name of ["pi-shell-owner.mjs", "pi-shell-owner.py"]) {
    pending.set(join(base, name), readFileSync(join(here, name), "utf8"));
  }
  for (const [path, source] of pending) if (readExisting(path) !== source) writeFileSync(path, source);
}

function readExisting(path) {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-bash-cancellation.mjs NODE_MODULES");
  patchBashCancellationCopies(resolve(process.argv[2]));
}
