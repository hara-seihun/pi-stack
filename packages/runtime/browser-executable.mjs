import { accessSync, chmodSync, constants, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const names = new Map([
  ["linux:x64", "agent-browser-linux-x64"],
  ["linux:arm64", "agent-browser-linux-arm64"],
  ["darwin:x64", "agent-browser-darwin-x64"],
  ["darwin:arm64", "agent-browser-darwin-arm64"],
  ["win32:x64", "agent-browser-win32-x64.exe"],
]);

export function browserExecutable({ nodeModules, platform, architecture, action }) {
  if (!["prepare", "verify"].includes(action) || typeof nodeModules !== "string" || !nodeModules) {
    return { ok: false, error: "browser_executable_arguments" };
  }
  const name = names.get(`${platform}:${architecture}`);
  if (!name) return { ok: false, error: "browser_executable_platform" };
  const path = join(nodeModules, "agent-browser", "bin", name);
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile()) return { ok: false, error: "browser_executable_not_regular" };
    if (action === "prepare" && platform !== "win32") chmodSync(path, (metadata.mode & 0o777) | 0o111);
    accessSync(path, constants.X_OK);
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: "browser_executable_unavailable", cause: error.code };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = browserExecutable({ nodeModules: process.argv[3], action: process.argv[2], platform: process.platform, architecture: process.arch });
  if (!result.ok) {
    console.error(JSON.stringify(result));
    process.exitCode = 1;
  }
}
