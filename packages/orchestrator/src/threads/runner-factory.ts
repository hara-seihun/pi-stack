import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AsyncLocalStorage } from "node:async_hooks";
import type { OpenPiSession } from "./contracts.js";

export const RUNNER_FACTORY_PROTOCOL = "native-future-factory-v1";
export interface RunnerFactoryIdentity {
  entryPath: string;
  entrySha256: string;
  sdkDirectory: string;
  sourceCommit: string | null;
}
export interface RunnerFactoryModule {
  runnerFactoryProtocol: typeof RUNNER_FACTORY_PROTOCOL;
  openPiSession: OpenPiSession;
  piEnvironmentScope: AsyncLocalStorage<NodeJS.ProcessEnv>;
  runnerSdkDirectory: string;
  runnerProjectionContinuity(): boolean;
}
export const FACTORY_ERROR_CODES = ["factory-conflict", "factory-unavailable", "factory-unsealed", "factory-contract-invalid", "ownership-conflict", "finite-bootstrap-required"] as const;
export type FactoryError = { code: typeof FACTORY_ERROR_CODES[number]; message: string };
export const isFactoryErrorCode = (code: unknown): code is FactoryError["code"] => FACTORY_ERROR_CODES.some(known => known === code);
export type FactoryResult<T> = { ok: true; value: T } | { ok: false; error: FactoryError };
export interface RunnerFactoryBinding { identity: RunnerFactoryIdentity; module: RunnerFactoryModule }
export const sameFactory = (a: RunnerFactoryIdentity, b: RunnerFactoryIdentity): boolean =>
  a.entryPath === b.entryPath && a.entrySha256 === b.entrySha256 && a.sdkDirectory === b.sdkDirectory && a.sourceCommit === b.sourceCommit;

export function identifyRunnerFactory(entryPath: string): FactoryResult<RunnerFactoryIdentity> {
  try {
    if (!isAbsolute(entryPath) || realpathSync(entryPath) !== entryPath || !statSync(entryPath).isFile())
      return { ok: false, error: { code: "factory-unsealed", message: "Factory entry must be an exact canonical file, not a selector" } };
    const manifest = join(dirname(entryPath), "../..", ".pi-stack-commit");
    const sourceCommit = existsSync(manifest) ? readFileSync(manifest, "utf8").trim() : null;
    if (sourceCommit !== null && !/^[a-f0-9]{40}$/.test(sourceCommit))
      return { ok: false, error: { code: "factory-unsealed", message: "Factory source commit is invalid" } };
    let sdkDirectory: string;
    if (process.versions.bun) {
      const bun = (globalThis as unknown as { Bun?: { resolveSync(specifier: string, parent: string): string } }).Bun;
      if (typeof bun?.resolveSync !== "function") return { ok: false, error: { code: "factory-unavailable", message: "Native Bun requires candidate-scoped ESM package lookup" } };
      sdkDirectory = realpathSync(join(dirname(bun.resolveSync("@earendil-works/pi-coding-agent", dirname(entryPath))), ".."));
    } else {
      const findPackageJSON = (nodeModule as unknown as { findPackageJSON?: (specifier: string, base: URL) => string | undefined }).findPackageJSON;
      if (!findPackageJSON) return { ok: false, error: { code: "factory-unavailable", message: "Native Node requires candidate-scoped ESM package lookup" } };
      const sdkManifest = findPackageJSON("@earendil-works/pi-coding-agent", pathToFileURL(entryPath));
      if (!sdkManifest || JSON.parse(readFileSync(sdkManifest, "utf8")).name !== "@earendil-works/pi-coding-agent")
        return { ok: false, error: { code: "factory-contract-invalid", message: "Candidate ESM SDK package identity is absent or invalid" } };
      sdkDirectory = realpathSync(dirname(sdkManifest));
    }
    return { ok: true, value: { entryPath, entrySha256: createHash("sha256").update(readFileSync(entryPath)).digest("hex"), sdkDirectory, sourceCommit } };
  } catch (cause) { return { ok: false, error: { code: "factory-unavailable", message: String(cause) } }; }
}

export async function loadRunnerFactory(identity: RunnerFactoryIdentity): Promise<FactoryResult<RunnerFactoryBinding>> {
  const observed = identifyRunnerFactory(identity.entryPath);
  if (!observed.ok) return observed;
  if (!sameFactory(observed.value, identity)) return { ok: false, error: { code: "factory-conflict", message: "Candidate immutable factory identity changed" } };
  if (identity.sourceCommit === null || dirname(dirname(dirname(identity.entryPath))).split("/").at(-1) !== identity.sourceCommit)
    return { ok: false, error: { code: "factory-unsealed", message: "Upgrades require an immutable commit-addressed release" } };
  try {
    if ((statSync(identity.sdkDirectory).mode & 0o222) !== 0)
      return { ok: false, error: { code: "factory-unsealed", message: "Upgrades require an immutable read-only SDK graph" } };
    const candidate = await import(pathToFileURL(identity.entryPath).href) as RunnerFactoryModule;
    if (candidate.runnerFactoryProtocol !== RUNNER_FACTORY_PROTOCOL || typeof candidate.openPiSession !== "function"
      || typeof candidate.piEnvironmentScope?.run !== "function" || typeof candidate.piEnvironmentScope?.getStore !== "function"
      || candidate.runnerSdkDirectory !== identity.sdkDirectory || typeof candidate.runnerProjectionContinuity !== "function" || !candidate.runnerProjectionContinuity())
      return { ok: false, error: { code: "factory-contract-invalid", message: "Candidate does not export the exact native factory/environment/SDK contract" } };
    const after = identifyRunnerFactory(identity.entryPath);
    if (!after.ok) return after;
    if (!sameFactory(after.value, identity)) return { ok: false, error: { code: "factory-conflict", message: "Candidate changed while loading" } };
    return { ok: true, value: { identity, module: candidate } };
  } catch (cause) { return { ok: false, error: { code: "factory-unavailable", message: String(cause) } }; }
}

export class RunnerFutureFactory {
  private current: RunnerFactoryBinding;
  constructor(initial: RunnerFactoryBinding, private readonly assertLease: () => void,
    private readonly load: typeof loadRunnerFactory = loadRunnerFactory) { this.current = this.seal(initial); }
  private seal(binding: RunnerFactoryBinding): RunnerFactoryBinding {
    Object.freeze(binding.identity);
    return Object.freeze(binding);
  }
  snapshot(): RunnerFactoryBinding { return this.current; }
  async upgrade(expected: RunnerFactoryIdentity, candidate: RunnerFactoryIdentity): Promise<FactoryResult<{ previous: RunnerFactoryIdentity; current: RunnerFactoryIdentity }>> {
    try { this.assertLease(); }
    catch (cause) { return { ok: false, error: { code: "ownership-conflict", message: String(cause) } }; }
    if (!sameFactory(this.current.identity, expected)) return { ok: false, error: { code: "factory-conflict", message: "Current future factory differs from expected predecessor" } };
    if (sameFactory(expected, candidate)) return { ok: true, value: { previous: expected, current: expected } };
    const loaded = await this.load(candidate);
    if (!loaded.ok) return loaded;
    try { this.assertLease(); }
    catch (cause) { return { ok: false, error: { code: "ownership-conflict", message: String(cause) } }; }
    if (!sameFactory(this.current.identity, expected)) return { ok: false, error: { code: "factory-conflict", message: "Future factory changed during preparation" } };
    const previous = this.current.identity;
    this.current = this.seal(loaded.value);
    return { ok: true, value: { previous, current: this.current.identity } };
  }
}

export function bindRunnerEnvironments<T>(scopes: readonly AsyncLocalStorage<NodeJS.ProcessEnv>[], env: NodeJS.ProcessEnv, action: () => T): T {
  const unique = [...new Set(scopes)];
  const enter = (index: number): T => index === unique.length ? action() : unique[index]!.run(env, () => enter(index + 1));
  return enter(0);
}
