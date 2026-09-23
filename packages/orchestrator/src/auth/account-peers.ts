import { spawn, type ChildProcess } from "node:child_process";
import type { PeerHost } from "../domain.js";

const sshHostPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/;
const peerNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sshHost(value: unknown, field: string): string {
  if (typeof value !== "string" || !sshHostPattern.test(value))
    throw new Error(`${field} must be an SSH host alias`);
  return value;
}

export function parsePeerHosts(value: unknown): Readonly<Record<string, PeerHost>> {
  if (value === undefined) return {};
  const entries = record(value);
  if (!entries) throw new Error("peers must be an object");
  const peers: Record<string, PeerHost> = {};
  for (const [name, input] of Object.entries(entries)) {
    if (!peerNamePattern.test(name)) throw new Error(`Invalid peer name ${name}`);
    const peer = record(input);
    if (!peer || Object.keys(peer).some(key => !["sshHost", "returnRoute"].includes(key)))
      throw new Error(`peer ${name} must contain sshHost and optional returnRoute`);
    const routeInput = peer.returnRoute;
    let returnRoute: PeerHost["returnRoute"];
    if (routeInput !== undefined) {
      const route = record(routeInput);
      if (!route || Object.keys(route).some(key => !["sshHost", "port"].includes(key)))
        throw new Error(`peer ${name} returnRoute must contain sshHost and port`);
      const port = route.port;
      if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65_535)
        throw new Error(`peer ${name} returnRoute port must be an integer from 1 to 65535`);
      returnRoute = { sshHost: sshHost(route.sshHost, `peer ${name} returnRoute sshHost`), port: Number(port) };
    }
    peers[name] = { sshHost: sshHost(peer.sshHost, `peer ${name} sshHost`), ...(returnRoute ? { returnRoute } : {}) };
  }
  return peers;
}

export interface ResolvedPeerHost extends PeerHost {
  readonly name?: string;
}

export function resolvePeerHost(peers: Readonly<Record<string, PeerHost>>, reference: string): ResolvedPeerHost {
  const configured = peers[reference];
  if (configured) return { name: reference, ...configured };
  return { sshHost: sshHost(reference, "Transfer destination") };
}

export function resolveFetchPeer(peers: Readonly<Record<string, PeerHost>>, reference: string): ResolvedPeerHost & { returnRoute: NonNullable<PeerHost["returnRoute"]> } {
  const configured = peers[reference];
  if (!configured) throw new Error(`Fetch source ${reference} is not a configured peer`);
  if (!configured.returnRoute) throw new Error(`Peer ${reference} has no returnRoute for account fetch`);
  return { name: reference, ...configured, returnRoute: configured.returnRoute };
}

type SpawnProcess = (command: string, args: readonly string[], options: { readonly stdio: ["ignore", "inherit", "inherit"]; readonly signal: AbortSignal }) => ChildProcess;
const spawnProcess: SpawnProcess = (command, args, options) => spawn(command, [...args], options);
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export async function fetchAccountFromPeer(
  alias: string,
  peer: ResolvedPeerHost & { returnRoute: NonNullable<PeerHost["returnRoute"]> },
  waitForDrainMs: number | undefined,
  signal: AbortSignal,
  launch: SpawnProcess = spawnProcess,
): Promise<void> {
  const transfer = ["pi-orchestrator", "account", "transfer", alias, "--to", peer.returnRoute.sshHost];
  if (waitForDrainMs !== undefined) transfer.push("--wait-for-drain", `${waitForDrainMs}ms`);
  const args = [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ExitOnForwardFailure=yes",
    "-R", `127.0.0.1:${peer.returnRoute.port}:127.0.0.1:22`,
    peer.sshHost,
    transfer.map(quote).join(" "),
  ];
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try { child = launch("ssh", args, { stdio: ["ignore", "inherit", "inherit"], signal }); }
    catch { reject(new Error(`Could not start account fetch from peer ${peer.name ?? peer.sshHost}`)); return; }
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      outcome();
    };
    child.once("error", () => finish(() => reject(new Error(`Account fetch transport from peer ${peer.name ?? peer.sshHost} failed`))));
    child.once("close", code => finish(() => code === 0
      ? resolve()
      : reject(new Error(`Account fetch from peer ${peer.name ?? peer.sshHost} exited ${code ?? "without a status"}`))));
  });
}
