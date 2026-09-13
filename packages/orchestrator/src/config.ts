import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { catalogModel } from "./catalog.js";
import type { OrchestratorConfig } from "./domain.js";
import { defaultSharedAuthPath } from "./auth/shared-oauth.js";
import { configuredCore, isCoreId, type CoreId } from "./cores/index.js";

export function resolveCore(config: Pick<OrchestratorConfig, "core" | "profileCores">, profile: string, override?: CoreId): CoreId {
  return configuredCore(override ?? config.profileCores?.[profile] ?? config.core);
}

const standard = catalogModel("astra")!;
const expert = catalogModel("opus")!;

export function loadConfig(
  path = process.env.PI_ORCHESTRATOR_CONFIG ?? join(homedir(), ".config/pi-orchestrator/config.json"),
  ledgerPath = process.env.PI_ORCHESTRATOR_LEDGER || join(homedir(), ".local/share/pi-orchestrator/ledger.sqlite3"),
): OrchestratorConfig {
  let local: any = {};
  try { local = JSON.parse(readFileSync(path,"utf8")); } catch (error: any) { if(error?.code!=="ENOENT") throw error; }
  const candidate=({provider,model,thinking}:{provider:string;model:string;thinking?:string})=>({provider,model,thinking});
  const profiles = {
    ...(local.profiles ?? {
      standard: [candidate(standard),candidate(expert)],
      expert: [candidate(expert),candidate(standard)],
    }),
    ...Object.fromEntries(["astra", "sol", "terra", "luna", "opus"].map(id => [id, [candidate(catalogModel(id)!)]])),
  };
  if (local.core !== undefined && !isCoreId(local.core)) throw new Error(`Unknown agent core ${String(local.core)}`);
  if (local.profileCores !== undefined && (!local.profileCores || typeof local.profileCores !== "object" || Array.isArray(local.profileCores))) throw new Error("profileCores must map profile names to core IDs");
  for (const [profile, core] of Object.entries(local.profileCores ?? {})) {
    if (!isCoreId(core)) throw new Error(`profile ${profile}: unknown agent core ${String(core)}`);
  }
  const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  for (const [profile, candidates] of Object.entries(profiles)) {
    for (const entry of candidates as any[]) {
      if (entry.thinkingPair === undefined) continue;
      const pair = entry.thinkingPair;
      if (entry.thinking !== undefined || !Array.isArray(pair) || pair.length !== 2 ||
          pair[0] === pair[1] || pair.some(level => !levels.has(level))) {
        throw new Error(`profile ${profile}: thinkingPair requires two distinct thinking levels and no thinking field`);
      }
    }
  }
  return {
    listenHost: process.env.PI_ORCHESTRATOR_LISTEN_HOST || local.listenHost,
    profiles,
    core: configuredCore(local.core),
    profileCores: local.profileCores ?? {},
    backgroundSpendFraction: Number(local.backgroundSpendFraction ?? 0.8),
    maxConcurrentSessions: Number(local.maxConcurrentSessions ?? 40),
    defaultAccountConcurrency: Number(local.defaultAccountConcurrency ?? 4),
    meterMaxAgeMs: Number(local.meterMaxAgeMs ?? 90*60_000),
    reconcileIntervalMs: Number(local.reconcileIntervalMs ?? 5_000),
    stallAfterMs: Number(local.stallAfterMs ?? 20*60_000),
    killAfterMs: Number(local.killAfterMs ?? 30*60_000),
    taskManifest: local.taskManifest,
    authPath: process.env.PI_ORCHESTRATOR_AUTH || local.authPath || defaultSharedAuthPath(ledgerPath),
    agentDir: process.env.PI_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || local.agentDir || join(homedir(),".pi/agent"),
  };
}
