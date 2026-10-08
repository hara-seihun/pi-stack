import { createConnection } from "node:net";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Status = { ok?: boolean; historySource?: string };
export class NativeHistoryStartupError extends Error {
  readonly exitCode = 75;
  constructor(message: string) { super(message); this.name = "NativeHistoryStartupError"; }
}
export function nativeRunnerStatus(path: string): Promise<Status> {
  return new Promise((resolveStatus, reject) => {
    const socket = createConnection(path); let body = "";
    const timer = setTimeout(() => socket.destroy(new Error("Native ownership status timed out")), 3000);
    socket.on("connect", () => socket.write(JSON.stringify({ type: "status" }) + "\n"));
    socket.on("data", chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) { socket.destroy(new Error("Native ownership status is oversized")); return; }
      if (!body.includes("\n")) return;
      try { const value = JSON.parse(body.split("\n")[0]); clearTimeout(timer); socket.destroy(); resolveStatus(value); }
      catch (error) { socket.destroy(error as Error); }
    });
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("end", () => { clearTimeout(timer); reject(new Error("Native ownership status ended without a receipt")); });
  });
}
/** Inspect only protocol identities and spool sizes, never decode old frames. */
export async function fleetNativeSource(socketDir: string, status = nativeRunnerStatus): Promise<"native" | "legacy"> {
  const controls = join(socketDir, "thread-runners"), spools = join(socketDir, "thread-sockets");
  const native = new Set<string>(); let legacy = false;
  const names = existsSync(controls) ? readdirSync(controls).filter(name => name.endsWith(".sock")) : [];
  if (names.length > 256) throw new NativeHistoryStartupError("Native ownership census exceeds the bounded startup window");
  for (const name of names) {
    let receipt: Status;
    try { receipt = await status(join(controls, name)); }
    catch { throw new NativeHistoryStartupError("Native producer ownership is unavailable; preserve its output and retry startup"); }
    if (receipt.ok === true && receipt.historySource === "native-jsonl-v1") native.add(name.slice(0, -5));
    else legacy = true;
  }
  if (existsSync(spools)) {
    const output = readdirSync(spools).filter(name => name.endsWith(".events"));
    if (output.length > 4096) throw new NativeHistoryStartupError("Native output census exceeds the bounded startup window");
    for (const name of output) {
      if (statSync(join(spools, name)).size && ![...native].some(generation => name.startsWith(`${generation}.`))) legacy = true;
    }
  }
  return legacy ? "legacy" : "native";
}
function trusted(path: string, directory = false): boolean {
  const info = statSync(path);
  return (info.uid === 0 || info.uid === process.getuid!()) && !(info.mode & 0o022) && (directory ? info.isDirectory() : info.isFile());
}
export function fleetLegacyManifest(releaseRoot: string, manifestRoot = "/srv/pi/.pi-stack-maintenance/native-history"): Record<string, string> {
  try {
    const candidate = readFileSync(join(releaseRoot, ".pi-stack-commit"), "utf8").trim();
    if (!/^[a-f0-9]{40}$/.test(candidate)) throw new Error("Unstamped candidate");
    const path = join(manifestRoot, candidate, "legacy.json");
    if (!trusted(path) || statSync(path).size > 64 * 1024) throw new Error("Untrusted manifest");
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value.version !== 1 || value.candidate !== candidate || !/^[a-f0-9]{40}$/.test(value.legacySource)) throw new Error("Unbound source identity");
    for (const key of ["legacyRemote", "legacyOrchestrator", "bridgeModule", "migrator", "node"]) {
      if (typeof value[key] !== "string" || !value[key].startsWith("/") || resolve(value[key]) !== value[key] || !trusted(value[key], key.startsWith("legacy"))) throw new Error("Untrusted source path");
    }
    for (const root of [value.legacyRemote, value.legacyOrchestrator]) {
      if (readFileSync(join(root, ".pi-stack-commit"), "utf8").trim() !== value.legacySource) throw new Error("Source stamp changed");
    }
    if (!trusted(join(value.legacyOrchestrator, "dist/api.js")) || !trusted(join(value.legacyOrchestrator, "dist/cli.js"))) throw new Error("Old fleet API is unavailable");
    return value;
  } catch (error) {
    throw new NativeHistoryStartupError(`Retained legacy fleet producers/output require their exact publication maintenance source (${error instanceof Error ? error.message : String(error)}); queued work remains preserved`);
  }
}
export async function startFleetHistory(options: { socketDir: string; ledgerPath: string; releaseRoot: string }): Promise<"native" | "maintenance"> {
  if (!options.ledgerPath.startsWith("/") || resolve(options.ledgerPath) !== options.ledgerPath) throw new NativeHistoryStartupError("Fleet startup requires its exact absolute owner ledger");
  if (await fleetNativeSource(options.socketDir) === "native") return "native";
  const manifest = fleetLegacyManifest(options.releaseRoot);
  const { installLegacyMaintenance, legacyFleetLedger } = await import(pathToFileURL(manifest.bridgeModule).href);
  const identity = { candidate: manifest.candidate, legacySource: manifest.legacySource };
  await legacyFleetLedger(options.ledgerPath, identity); // Existing accepted completions still run through the old claimant.
  const dataDir = dirname(options.ledgerPath);
  const owns = await installLegacyMaintenance({ ...manifest, mode: "fleet", autoAdvance: true, dataDir, ledgerPath: options.ledgerPath, oldApi: join(manifest.legacyOrchestrator, "dist/api.js") });
  if (owns === true) await import(pathToFileURL(join(manifest.legacyOrchestrator, "dist/cli.js")).href);
  else if (owns !== false) throw new NativeHistoryStartupError("Old fleet maintenance returned no explicit custody state");
  return "maintenance";
}
