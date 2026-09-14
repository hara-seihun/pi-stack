import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";

export function fleetThreadUrl(config: { fleetUser?: string }, person: string, override?: string): string | null {
  if (!config.fleetUser || config.fleetUser !== person) return null;
  const url = new URL(override ?? "http://127.0.0.1:2460");
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Fleet thread API requires an HTTP URL");
  return url.origin;
}

export function configuredFleetThreadUrl(): string | null {
  const path = process.env.PI_STACK_HOST_CONFIG ?? "/etc/pi-stack/host.json";
  if (!existsSync(path)) return null;
  return fleetThreadUrl(JSON.parse(readFileSync(path, "utf8")), userInfo().username, process.env.PI_REMOTE_ORCHESTRATOR_URL);
}
