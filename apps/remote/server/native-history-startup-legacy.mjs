#!/usr/bin/env bun
import { readFileSync, realpathSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const failure = (code, message) => ({ ok: false, error: { code, message } });
function trustedSource(path, kind) {
  const info = statSync(path);
  return (info.uid === 0 || info.uid === process.getuid()) && !(info.mode & 0o022) && (kind === "directory" ? info.isDirectory() : info.isFile());
}

export function legacySourceManifest({ releaseRoot, manifestRoot = "/srv/pi/.pi-stack-maintenance/native-history" }) {
  try {
    const candidate = readFileSync(join(releaseRoot, ".pi-stack-commit"), "utf8").trim();
    if (!/^[0-9a-f]{40}$/.test(candidate)) return failure("legacy-source", "Current release has no immutable candidate identity");
    const path = join(manifestRoot, candidate, "legacy.json");
    if (!trustedSource(path, "file") || statSync(path).size > 16 * 1024) return failure("legacy-source", "Legacy source manifest must be a small non-writable deployment asset");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (manifest.version !== 1 || manifest.candidate !== candidate || !/^[0-9a-f]{40}$/.test(manifest.legacySource)) return failure("legacy-source", "Legacy source manifest is not bound to this candidate");
    for (const field of ["legacyRemote", "legacyOrchestrator", "bridgeModule", "migrator", "node"]) {
      const value = manifest[field];
      if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || !trustedSource(value, field.startsWith("legacy") ? "directory" : "file")) {
        return failure("legacy-source", `Manifest ${field} is not an absolute, trusted deployment asset`);
      }
    }
    for (const root of [manifest.legacyRemote, manifest.legacyOrchestrator]) {
      if (readFileSync(join(root, ".pi-stack-commit"), "utf8").trim() !== manifest.legacySource) return failure("legacy-source", "Legacy release identities do not match the manifest");
    }
    const oldApi = join(manifest.legacyRemote, "node_modules/pi-orchestrator/src/api.ts");
    if (!realpathSync(oldApi).startsWith(realpathSync(manifest.legacyOrchestrator) + "/") || !trustedSource(oldApi, "file")) {
      return failure("legacy-source", "Old API is not the manifest's old Orchestrator module identity");
    }
    const oldMain = join(manifest.legacyRemote, "server/main.ts");
    if (!trustedSource(oldMain, "file")) return failure("legacy-source", "Old Remote entrypoint is not a trusted deployment asset");
    return { ok: true, value: { ...manifest, oldApi, oldMain } };
  } catch (error) { return failure("legacy-source", String(error?.message ?? error)); }
}

export async function runLegacyStartup(command) {
  if (!command.length) return failure("arguments", "Legacy bootstrap requires the original supervisor command");
  const gate = spawnSync("node", [fileURLToPath(new URL("native-history-startup.mjs", import.meta.url))], { encoding: "utf8", timeout: 52_000, maxBuffer: 1024 * 1024 });
  if (gate.error) return failure("startup-gate", gate.error.message);
  let receipt;
  try { receipt = JSON.parse(gate.stdout.trim()); }
  catch { return failure("startup-gate", `Startup gate returned no typed receipt (exit ${gate.status})`); }
  if (gate.status === 76 && receipt.ok === false && receipt.error.code === "legacy-required") {
    const { bootstrap } = receipt.error;
    if (!bootstrap || bootstrap.uid !== process.getuid() || !isAbsolute(bootstrap.dataDir)) return failure("startup-gate", "Legacy bootstrap owner binding is invalid");
    try {
      const { installLegacyMaintenance } = await import(pathToFileURL(bootstrap.bridgeModule).href);
      const needsOwner = await installLegacyMaintenance({ ...bootstrap, mode: "remote", autoAdvance: true });
      if (needsOwner === true) await import(pathToFileURL(bootstrap.oldMain).href);
      else if (needsOwner !== false) return failure("legacy-bootstrap", "Legacy bridge returned no explicit startup state");
      return { ok: true, value: { state: "legacy-maintenance" } };
    } catch (error) { return failure("legacy-bootstrap", String(error?.message ?? error)); }
  }
  if (!receipt.ok || gate.status !== 0) return failure("startup-gate", receipt.error?.message ?? "Startup gate failed");
  return await new Promise(resolveResult => {
    const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: process.env });
    const handoff = () => child.kill("SIGUSR2"), stop = () => child.kill("SIGTERM");
    process.on("SIGUSR2", handoff); process.on("SIGTERM", stop); process.on("SIGINT", stop);
    const cleanup = () => { process.off("SIGUSR2", handoff); process.off("SIGTERM", stop); process.off("SIGINT", stop); };
    child.once("error", error => { cleanup(); resolveResult(failure("candidate-startup", error.message)); });
    child.once("exit", (code, signal) => { cleanup(); resolveResult(code !== null ? { ok: true, value: { state: "candidate-exited", exitCode: code } } : failure("candidate-startup", `Candidate exited on signal ${signal}`)); });
  });
}

// Invoked through the /srv/pi/pi-remote release pointer; compare real paths.
const invokedDirectly = (() => {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (invokedDirectly) {
  const result = await runLegacyStartup(process.argv.slice(2));
  if (!result.ok) { console.error(JSON.stringify(result)); process.exitCode = 78; }
  else if (result.value.state === "candidate-exited") process.exitCode = result.value.exitCode;
}
