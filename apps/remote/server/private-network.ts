import { readFileSync } from "node:fs";
import type { NetworkStatus, PrivateNetwork } from "./protocol";

/** Set by the deployment's private entrance on requests that arrived over the configured network; client copies are overwritten there. */
export const NETWORK_HEADER = "x-pi-remote-network";

export function readPrivateNetwork(path = process.env.PI_REMOTE_PRIVATE_NETWORK_CONFIG): PrivateNetwork | null {
  if (!path) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as PrivateNetwork;
  const server = new URL(value.loginServer);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(value.id) || typeof value.name !== "string" || !value.name.trim() ||
      server.protocol !== "https:" || server.username || server.password || server.search || server.hash) {
    throw new Error("Invalid private network configuration: expected {id, name, loginServer} with an HTTPS login server");
  }
  return { id: value.id, name: value.name, loginServer: server.href.replace(/\/$/, "") };
}

export function networkStatus(network: PrivateNetwork | null, req: Request): NetworkStatus {
  return network ? { network, connected: req.headers.get(NETWORK_HEADER) === network.id } : { network: null };
}
