import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { admissionThinking, catalogModel, type ModelCandidate } from "./catalog.js";
import type { OrchestratorConfig } from "./domain.js";
import { defaultSharedAuthPath } from "./auth/shared-oauth.js";

const standard = catalogModel("astra")!;
const expert = catalogModel("opus")!;

export function loadConfig(
  path = process.env.PI_ORCHESTRATOR_CONFIG ?? join(homedir(), ".config/pi-orchestrator/config.json"),
  ledgerPath = process.env.PI_ORCHESTRATOR_LEDGER || join(homedir(), ".local/share/pi-orchestrator/ledger.sqlite3"),
): OrchestratorConfig {
  let local: any = {};
  try { local = JSON.parse(readFileSync(path,"utf8")); } catch (error: any) { if(error?.code!=="ENOENT") throw error; }
  const candidate=({provider,model}:ModelCandidate)=>({provider,model,thinking:admissionThinking({provider,model})});
  const profiles = {
    ...(local.profiles ?? {
      standard: [standard,expert],
      expert: [expert,standard],
    }),
    ...Object.fromEntries(["astra", "sol", "terra", "luna", "opus"].map(id => [id, [catalogModel(id)!]])),
  };
  return {
    listenHost: process.env.PI_ORCHESTRATOR_LISTEN_HOST || local.listenHost,
    profiles: Object.fromEntries(Object.entries(profiles).map(([profile, candidates]) => [profile, (candidates as ModelCandidate[]).map(candidate)])),
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
