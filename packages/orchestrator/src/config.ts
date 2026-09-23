import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { admissionThinking, catalogModel, type ModelCandidate } from "./catalog.js";
import type { OrchestratorConfig } from "./domain.js";
import { defaultSharedAuthPath } from "./auth/shared-oauth.js";
import { parsePeerHosts } from "./auth/account-peers.js";

const standard = catalogModel("astra")!;
const sol = catalogModel("sol")!;

function parsePort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const port = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Orchestrator port must be an integer from 1 to 65535");
  return port;
}

export function orchestratorUrl(env: NodeJS.ProcessEnv = process.env, configPath?: string): string {
  const config = loadConfig(configPath, undefined, env);
  if (config.modelBrokerUrl && config.port === undefined) throw new Error("This person's Orchestrator needs its own configured port; administrator access is not a substitute");
  const host = env.PI_ORCHESTRATOR_HOST ?? "127.0.0.1";
  return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${config.port ?? 2460}`;
}

export function loadConfig(
  path?: string,
  ledgerPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): OrchestratorConfig {
  const home = env.HOME || homedir();
  path ??= env.PI_ORCHESTRATOR_CONFIG ?? join(home, ".config/pi-orchestrator/config.json");
  ledgerPath ??= env.PI_ORCHESTRATOR_LEDGER || join(home, ".local/share/pi-orchestrator/ledger.sqlite3");
  let local: any = {};
  try { local = JSON.parse(readFileSync(path,"utf8")); } catch (error: any) { if(error?.code!=="ENOENT") throw error; }
  const candidate=({provider,model}:ModelCandidate)=>({provider,model,thinking:admissionThinking({provider,model})});
  const profiles = {
    ...(local.profiles ?? {
      standard: [standard, sol],
      expert: [standard],
    }),
    ...Object.fromEntries(["astra", "sol", "luna"].map(id => [id, [catalogModel(id)!]])),
  };
  for (const [profile, candidates] of Object.entries(profiles)) {
    if (!Array.isArray(candidates) || candidates.some(candidate => candidate?.provider !== "openai-codex")) {
      throw new Error(`Orchestrator scheduling profile ${profile} must contain only OpenAI Codex models`);
    }
  }
  const modelBrokerUrl = env.PI_MODEL_BROKER_URL ?? local.modelBrokerUrl;
  if (modelBrokerUrl !== undefined && typeof modelBrokerUrl !== "string") throw new Error("modelBrokerUrl must be a string");
  return {
    modelBrokerUrl,
    port: parsePort(env.PI_ORCHESTRATOR_PORT ?? local.port),
    listenHost: env.PI_ORCHESTRATOR_LISTEN_HOST || local.listenHost,
    peers: parsePeerHosts(local.peers),
    profiles: Object.fromEntries(Object.entries(profiles).map(([profile, candidates]) => [profile, (candidates as ModelCandidate[]).map(candidate)])),
    backgroundSpendFraction: Number(local.backgroundSpendFraction ?? 0.8),
    maxConcurrentSessions: Number(local.maxConcurrentSessions ?? 40),
    defaultAccountConcurrency: Number(local.defaultAccountConcurrency ?? 4),
    meterMaxAgeMs: Number(local.meterMaxAgeMs ?? 90*60_000),
    reconcileIntervalMs: Number(local.reconcileIntervalMs ?? 5_000),
    stallAfterMs: Number(local.stallAfterMs ?? 20*60_000),
    killAfterMs: Number(local.killAfterMs ?? 30*60_000),
    taskManifest: local.taskManifest,
    authPath: env.PI_ORCHESTRATOR_AUTH || local.authPath || defaultSharedAuthPath(ledgerPath, env),
    agentDir: env.PI_AGENT_DIR || env.PI_CODING_AGENT_DIR || local.agentDir || join(home,".pi/agent"),
  };
}
