import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { loadConfig, orchestratorUrl } from "pi-orchestrator/api";

type HostConfig = { fleetUser?: string };

function httpOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Orchestrator thread API requires an HTTP URL");
  return url.origin;
}

export function orchestratorThreadUrl(config: HostConfig, person: string, personalUrl?: string, fleetOverride?: string): string | null {
  if (config.fleetUser === person) return httpOrigin(fleetOverride ?? personalUrl ?? "http://127.0.0.1:2460");
  return personalUrl ? httpOrigin(personalUrl) : null;
}

export function configuredOrchestratorThreadUrl(env: NodeJS.ProcessEnv = process.env, person = userInfo().username): string | null {
  const path = env.PI_STACK_HOST_CONFIG ?? "/etc/pi-stack/host.json";
  const hostConfig: HostConfig = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const personalConfig = loadConfig(undefined, undefined, env);
  const personalUrl = hostConfig.fleetUser === person || personalConfig.port !== undefined || personalConfig.modelBrokerUrl !== undefined
    ? orchestratorUrl(env)
    : undefined;
  return orchestratorThreadUrl(hostConfig, person, personalUrl, env.PI_REMOTE_ORCHESTRATOR_URL);
}
