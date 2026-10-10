import { createConnection } from "node:net";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Status = { ok: true; historySource?: string };
type StatusFailure = {
  code: "missing" | "refused" | "timeout" | "closed" | "oversized" | "protocol" | "transport";
  message: string;
};
export type RunnerStatusResult = { ok: true; value: Status } | { ok: false; error: StatusFailure };
type RunnerCensusBase = { socket: string; generation: string; attempts: number; latencyMs: number };
export type RunnerCensus = RunnerCensusBase & (
  { kind: "native" } | { kind: "legacy" } | { kind: "unverified"; error: StatusFailure }
);
export type FleetNativeCensus = {
  version: 1;
  kind: "fleet-native-census";
  observedAt: string;
  source: "native" | "legacy";
  runners: RunnerCensus[];
  legacySpools: string[];
};
export class NativeHistoryStartupError extends Error {
  readonly exitCode = 75;
  constructor(message: string) { super(message); this.name = "NativeHistoryStartupError"; }
}
export function nativeRunnerStatus(path: string): Promise<RunnerStatusResult> {
  return new Promise(resolveStatus => {
    const socket = createConnection(path); let body = "", settled = false;
    const finish = (result: RunnerStatusResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy(); resolveStatus(result);
    };
    const failure = (code: StatusFailure["code"], message: string) => finish({ ok: false, error: { code, message } });
    const timer = setTimeout(() => failure("timeout", "Native ownership status timed out after 3000ms"), 3000);
    socket.on("connect", () => socket.write(JSON.stringify({ type: "status" }) + "\n"));
    socket.on("data", chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) { failure("oversized", "Native ownership status is oversized"); return; }
      if (!body.includes("\n")) return;
      let value: unknown;
      try { value = JSON.parse(body.split("\n")[0]); }
      catch { failure("protocol", "Native ownership status is not JSON"); return; }
      if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== true ||
          ("historySource" in value && typeof value.historySource !== "string")) {
        failure("protocol", "Native ownership status did not acknowledge a valid receipt"); return;
      }
      finish({ ok: true, value: value as Status });
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      const code = error.code === "ENOENT" ? "missing" : error.code === "ECONNREFUSED" ? "refused" : "transport";
      failure(code, error.message);
    });
    socket.on("end", () => failure("closed", "Native ownership status ended without a receipt"));
    socket.on("close", () => failure("closed", "Native ownership status closed without a receipt"));
  });
}
/** Inspect only protocol identities and spool sizes, never decode old frames. */
export async function fleetNativeCensus(socketDir: string, status = nativeRunnerStatus): Promise<FleetNativeCensus> {
  const controls = join(socketDir, "thread-runners"), spools = join(socketDir, "thread-sockets");
  const names = existsSync(controls) ? readdirSync(controls).filter(name => name.endsWith(".sock")).sort() : [];
  if (names.length > 256) throw new NativeHistoryStartupError("Native ownership census exceeds the bounded startup window");
  const runners = await Promise.all(names.map(async (name): Promise<RunnerCensus> => {
    const socket = join(controls, name), generation = name.slice(0, -5), started = performance.now();
    let receipt = await status(socket), attempts = 1;
    if (!receipt.ok && receipt.error.code === "timeout") { attempts++; receipt = await status(socket); }
    const base = { socket, generation, attempts, latencyMs: Math.ceil(performance.now() - started) };
    if (!receipt.ok) return { ...base, kind: "unverified", error: receipt.error };
    return { ...base, kind: receipt.value.historySource === "native-jsonl-v1" ? "native" : "legacy" };
  }));
  const native = new Set(runners.filter(runner => runner.kind === "native").map(runner => runner.generation));
  const legacySpools: string[] = [];
  if (existsSync(spools)) {
    const output = readdirSync(spools).filter(name => name.endsWith(".events")).sort();
    if (output.length > 4096) throw new NativeHistoryStartupError("Native output census exceeds the bounded startup window");
    for (const name of output) {
      const path = join(spools, name);
      let size: number;
      try { size = statSync(path).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (size && ![...native].some(generation => name.startsWith(`${generation}.`))) legacySpools.push(path);
    }
  }
  return { version: 1, kind: "fleet-native-census", observedAt: new Date().toISOString(),
    source: legacySpools.length || runners.some(runner => runner.kind === "legacy") ? "legacy" : "native", runners, legacySpools };
}
export async function fleetNativeSource(socketDir: string, status = nativeRunnerStatus): Promise<"native" | "legacy"> {
  const receipt = await fleetNativeCensus(socketDir, status);
  console.error(JSON.stringify(receipt));
  return receipt.source;
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
  const census = await fleetNativeCensus(options.socketDir);
  console.error(JSON.stringify(census));
  if (census.source === "native") return "native";
  let manifest: Record<string, string>;
  try { manifest = fleetLegacyManifest(options.releaseRoot); }
  catch (error) {
    if (!(error instanceof NativeHistoryStartupError)) throw error;
    throw new NativeHistoryStartupError(`${error.message}; runners: ${census.runners.filter(runner => runner.kind !== "native").map(runner => runner.socket).join(", ")}; retained output: ${census.legacySpools.join(", ")}`);
  }
  const { installLegacyMaintenance, legacyFleetLedger } = await import(pathToFileURL(manifest.bridgeModule).href);
  const identity = { candidate: manifest.candidate, legacySource: manifest.legacySource };
  await legacyFleetLedger(options.ledgerPath, identity); // Existing accepted completions still run through the old claimant.
  const dataDir = dirname(options.ledgerPath);
  const owns = await installLegacyMaintenance({ ...manifest, mode: "fleet", autoAdvance: true, dataDir, ledgerPath: options.ledgerPath, oldApi: join(manifest.legacyOrchestrator, "dist/api.js") });
  if (owns === true) await import(pathToFileURL(join(manifest.legacyOrchestrator, "dist/cli.js")).href);
  else if (owns !== false) throw new NativeHistoryStartupError("Old fleet maintenance returned no explicit custody state");
  return "maintenance";
}
