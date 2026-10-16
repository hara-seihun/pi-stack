import { spawn, spawnSync } from "node:child_process";
import { chmodSync, chownSync, closeSync, constants, fstatSync, lstatSync, openSync, unlinkSync } from "node:fs";
import { createServer as createHttpServer, type RequestListener } from "node:http";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreResult } from "./config.js";
import { registerGatewaySocket, assertGatewayRequest, type GatewayBinding, type GatewayTransportConfig } from "./gateway.js";
const peerHelper = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./gateway-peer.py" : "../../src/core/gateway-peer.py", import.meta.url));
export type KernelPeer = { pid: number; uid: number; gid: number };
export async function kernelPeer(socket: Socket): Promise<CoreResult<KernelPeer>> {
  const fd = (socket as Socket & { _handle?: { fd?: number } })._handle?.fd;
  if (!Number.isSafeInteger(fd) || Number(fd) < 0) return { ok: false, error: { code: "unavailable", message: "Accepted Unix socket has no kernel credential descriptor" } };
  return new Promise(resolve => {
    const child = spawn("/usr/bin/python3", [peerHelper], { stdio: ["ignore", "pipe", "pipe", fd!], env: { PATH: "/usr/bin:/bin", LANG: "C" } });
    let output = "", settled = false;
    const finish = (result: CoreResult<KernelPeer>) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const reject = () => finish({ ok: false, error: { code: "unavailable", message: "Kernel Unix peer credential acquisition failed" } });
    const timer = setTimeout(() => { child.kill(); reject(); }, 2000);
    child.stdout!.on("data", chunk => { output += chunk; if (output.length > 1024) { child.kill(); reject(); } });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) { reject(); return; }
      try {
        const peer = JSON.parse(output);
        if (![peer.pid, peer.uid, peer.gid].every(value => Number.isSafeInteger(value) && value >= 0) || peer.pid === 0) { reject(); return; }
        finish({ ok: true, value: peer });
      } catch { reject(); }
    });
  });
}
export type GatewayTransports = { close(): Promise<void> };
export async function recoverGatewaySocket(path: string, ownerUid: number): Promise<void> {
  let identity: ReturnType<typeof lstatSync>;
  try { identity = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!identity.isSocket() || identity.uid !== ownerUid || (identity.mode & 0o777) !== 0o600) throw new Error("Gateway socket is outside its registered protected ownership");
  await new Promise<void>((done, reject) => {
    const probe = createConnection(path);
    const timer = setTimeout(() => { probe.destroy(); reject(new Error("Gateway listener ownership is uncertain")); }, 1000);
    probe.once("connect", () => { clearTimeout(timer); probe.destroy(); reject(new Error("Gateway listener is still live")); });
    probe.once("error", error => {
      clearTimeout(timer);
      if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED") { reject(error); return; }
      try {
        const current = lstatSync(path);
        if (current.dev !== identity.dev || current.ino !== identity.ino || !current.isSocket() || current.uid !== ownerUid || (current.mode & 0o777) !== 0o600) throw new Error("Gateway socket changed during absence proof");
        unlinkSync(path); done();
      } catch (cause) { reject(cause); }
    });
  });
}
export function acquireGatewaySocketOwner(path: string, ownerUid: number): () => void {
  const fd = openSync(path + ".owner.lock", constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.uid !== ownerUid || file.mode & 0o022) throw new Error("Gateway owner lock is not its protected registered custody");
    const locked = spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "pipe", "pipe", fd], timeout: 1000 });
    if (locked.error || locked.status !== 0) throw new Error("Gateway socket has another resource owner");
    return () => closeSync(fd);
  } catch (error) { closeSync(fd); throw error; }
}
export function createGatewayServer(binding: GatewayBinding, handler: RequestListener): { server: Server; close(): Promise<void> } {
  const sockets = new Set<Socket>(), active = new Map<Socket, number>();
  let stopping = false, closing: Promise<void> | undefined;
  const http = createHttpServer((req, res) => {
    if (stopping) { res.writeHead(503, { connection: "close" }); res.end(); return; }
    const admitted = assertGatewayRequest(binding, { method: req.method ?? "GET", url: new URL(req.url ?? "/", "http://gateway.local").href });
    if (!admitted.ok) { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify(admitted)); return; }
    active.set(req.socket, (active.get(req.socket) ?? 0) + 1);
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      const count = (active.get(req.socket) ?? 1) - 1;
      if (count) active.set(req.socket, count); else { active.delete(req.socket); if (stopping) req.socket.end(); }
    };
    res.once("finish", finish); res.once("close", finish);
    handler(req, res);
  });
  const server = createServer({ pauseOnConnect: true }, socket => {
    sockets.add(socket); socket.once("close", () => { sockets.delete(socket); active.delete(socket); });
    void kernelPeer(socket).then(peer => {
      if (!peer.ok || socket.destroyed || !registerGatewaySocket(socket, binding, peer.value).ok || stopping) { socket.destroy(); return; }
      http.emit("connection", socket); socket.resume();
    }, () => socket.destroy());
  });
  return { server, close: () => closing ??= (async () => {
    stopping = true;
    const stopped = server.listening ? new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())) : Promise.resolve();
    for (const socket of sockets) if (!active.has(socket)) socket.destroy();
    http.closeIdleConnections(); await stopped;
  })() };
}
export function gatewaySocketPath(config: Extract<GatewayTransportConfig, { kind: "unix" }>, binding: GatewayBinding): string { return join(config.socketDir, binding.gatewayId + ".sock"); }
export async function startGatewayTransports(config: GatewayTransportConfig, bindings: readonly GatewayBinding[], handler: RequestListener): Promise<CoreResult<GatewayTransports>> {
  const listeners: { close(): Promise<void>; unlock(): void; path: string; identity?: { dev: bigint; ino: bigint } }[] = [];
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    await Promise.all(listeners.map(async listener => {
      await listener.close();
      try {
        if (listener.identity) {
          const stat = lstatSync(listener.path, { bigint: true });
          if (stat.dev === listener.identity.dev && stat.ino === listener.identity.ino) unlinkSync(listener.path);
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      finally { listener.unlock(); }
    }));
  })();
  if (config.kind === "none") return bindings.length ? { ok: false, error: { code: "invalid-config", message: "Disabled gateway transport cannot carry bindings" } } : { ok: true, value: { close } };
  try {
    const directory = lstatSync(config.socketDir);
    if (!directory.isDirectory() || directory.uid !== 0 || directory.mode & 0o022) throw new Error("Gateway sockets require their prepared protected root-owned directory");
    for (const binding of bindings) {
      const path = gatewaySocketPath(config, binding);
      const unlock = acquireGatewaySocketOwner(path, 0);
      const transport = createGatewayServer(binding, handler), server = transport.server;
      const listener = { close: transport.close, unlock, path, identity: undefined as { dev: bigint; ino: bigint } | undefined }; listeners.push(listener);
      await recoverGatewaySocket(path, binding.peerUid);
      await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(path, () => { server.off("error", reject); done(); }); });
      listener.identity = lstatSync(path, { bigint: true });
      chownSync(path, binding.peerUid, 0); chmodSync(path, 0o600);
    }
    return { ok: true, value: { close } };
  } catch (cause) {
    await close();
    return { ok: false, error: { code: "unavailable", message: `Gateway transport cannot start: ${String(cause)}` } };
  }
}
