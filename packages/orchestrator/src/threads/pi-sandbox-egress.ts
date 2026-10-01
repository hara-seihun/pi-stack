import { Resolver } from "node:dns/promises";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

type Result<T> = { ok: true; value: T } | { ok: false; error: { code: "egress-denied" | "egress-unavailable" | "egress-start-failed"; message: string } };
export interface SandboxEgress {
  socketPath: string;
  close(): Promise<void>;
}
export const SANDBOX_PROXY_ENVIRONMENT = {
  HTTP_PROXY: "http://127.0.0.1:3128", HTTPS_PROXY: "http://127.0.0.1:3128",
  http_proxy: "http://127.0.0.1:3128", https_proxy: "http://127.0.0.1:3128",
  NO_PROXY: "", no_proxy: "",
};
const MAX_CONNECTIONS = 64;
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 30_000;
const LIFETIME_MS = 5 * 60_000;
const denied = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) denied.addSubnet(address, prefix, "ipv4");
denied.addAddress("168.63.129.16", "ipv4");
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) denied.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function isPublicSandboxAddress(address: string, localAddresses: string[] = []): boolean {
  const family = isIP(address);
  if (!family || address.includes("%")) return false;
  const type = family === 4 ? "ipv4" : "ipv6";
  if ((family === 6 && !globalV6.check(address, "ipv6")) || denied.check(address, type)) return false;
  const local = new BlockList();
  for (const own of localAddresses) {
    const ownFamily = isIP(own);
    if (ownFamily) local.addAddress(own, ownFamily === 4 ? "ipv4" : "ipv6");
  }
  return !local.check(address, type);
}

type Target = { hostname: string; port: number; path: string; authority: string };
function failure(message: string, code: "egress-denied" | "egress-unavailable" = "egress-denied"): Result<never> {
  return { ok: false, error: { code, message } };
}

export function parseSandboxProxyTarget(method: string, raw: string): Result<Target> {
  if (raw.length > 16_384 || /[^\x21-\x7e]|[\\#]/.test(raw)) return failure("Malformed proxy target");
  const tunnel = method === "CONNECT";
  const match = tunnel ? /^([^/?]+)$/.exec(raw) : /^http:\/\/([^/?]+)([/?].*)?$/.exec(raw);
  if (!match) return failure("Use an absolute HTTP URL or CONNECT host:443");
  const authority = match[1];
  const parts = /^(?:\[([0-9a-fA-F:]+)\]|([a-zA-Z0-9.-]+))(?::([0-9]+))?$/.exec(authority);
  if (!parts || (tunnel && !parts[3])) return failure("Malformed host or port");
  const hostname = (parts[1] ?? parts[2]).toLowerCase();
  if (parts[1] ? isIP(hostname) !== 6 : !validHostname(hostname)) return failure("Ambiguous or invalid hostname");
  const port = parts[3] ? Number(parts[3]) : 80;
  if (parts[3] && String(port) !== parts[3]) return failure("Non-canonical port");
  if (tunnel ? port !== 443 && port !== 80 : port !== 80) return failure("Only public HTTP port 80 and HTTPS port 443 are allowed");
  const path = tunnel ? "" : match[2] ? (match[2].startsWith("?") ? `/${match[2]}` : match[2]) : "/";
  return { ok: true, value: { hostname, port, path, authority } };
}
function validHostname(hostname: string): boolean {
  if (isIP(hostname) === 4) return true;
  if (hostname.length > 253) return false;
  const labels = hostname.split(".");
  return labels.length >= 2 && /[a-z]/.test(labels.at(-1)!)
    && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export async function resolveSandboxAddress(hostname: string): Promise<Result<{ address: string; family: 4 | 6 }>> {
  const resolver = new Resolver({ timeout: 2_000, tries: 1 });
  const timer = setTimeout(() => resolver.cancel(), CONNECT_TIMEOUT_MS);
  try {
    const literal = isIP(hostname);
    const answers = literal ? [hostname] : (await Promise.all([
      resolver.resolve4(hostname).catch(error => dnsAbsence(error)),
      resolver.resolve6(hostname).catch(error => dnsAbsence(error)),
    ])).flat();
    const ownAddresses = Object.values(networkInterfaces()).flatMap(entries => (entries ?? []).map(entry => entry.address));
    if (!answers.length) return failure("No DNS addresses for target", "egress-unavailable");
    if (answers.some(address => !isPublicSandboxAddress(address, ownAddresses))) return failure("Target resolves to a non-public or host address");
    return { ok: true, value: { address: answers[0], family: isIP(answers[0]) as 4 | 6 } };
  } catch {
    return failure("DNS resolution failed or timed out", "egress-unavailable");
  } finally {
    clearTimeout(timer);
    resolver.cancel();
  }
}
function dnsAbsence(error: NodeJS.ErrnoException): string[] {
  if (error.code === "ENODATA" || error.code === "ENOTFOUND") return [];
  throw error;
}

function forwardHeaders(headers: IncomingHttpHeaders, authority?: string): IncomingHttpHeaders {
  const excluded = new Set(["connection", "proxy-connection", "proxy-authorization", "proxy-authenticate", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "host"]);
  for (const item of (headers.connection ?? "").split(",")) excluded.add(item.trim().toLowerCase());
  return { ...Object.fromEntries(Object.entries(headers).filter(([key]) => !excluded.has(key.toLowerCase()))), ...(authority ? { host: authority } : {}), connection: "close" };
}

export type SandboxEgressPolicy = { profile: "public" } | { profile: "benchmark"; gatewaySocket: string };

export async function startSandboxEgress(policy: SandboxEgressPolicy = { profile: "public" }): Promise<Result<SandboxEgress>> {
  let directory: string | undefined;
  const sockets = new Set<Socket>();
  const requests = new WeakSet<Socket>();
  let closed = false;
  const resolvers = new Set<Promise<unknown>>();
  const server = createServer({ maxHeaderSize: 16_384, headersTimeout: 15_000, requestTimeout: 30_000 }, (incoming, outgoing) => {
    // One request per connection also bounds malicious HTTP pipelining queues.
    if (requests.has(incoming.socket)) { incoming.socket.destroy(); return; }
    requests.add(incoming.socket);
    const parsed = parseSandboxProxyTarget(incoming.method ?? "GET", incoming.url ?? "");
    const reject = (status: number, message: string) => {
      if (outgoing.destroyed) return;
      if (outgoing.headersSent) { outgoing.destroy(); return; }
      incoming.resume();
      outgoing.writeHead(status, { "content-type": "text/plain", connection: "close" });
      outgoing.end(`Sandbox egress: ${message}\n`);
    };
    if (!parsed.ok) { reject(403, parsed.error.message); return; }
    if (resolvers.size >= MAX_CONNECTIONS) { reject(503, "Too many concurrent requests"); return; }
    if (policy.profile === "benchmark" && parsed.value.authority !== "research.gateway") {
      reject(403, "This profile allows only http://research.gateway"); return;
    }
    const operation = (policy.profile === "benchmark"
      ? Promise.resolve({ ok: true, value: { address: "", family: 4 } } as const)
      : resolveSandboxAddress(parsed.value.hostname)).then(address => {
      if (closed || incoming.socket.destroyed) return;
      if (!address.ok) { reject(address.error.code === "egress-denied" ? 403 : 502, address.error.message); return; }
      const target = parsed.value;
      const upstream = request({
        ...(policy.profile === "benchmark" ? { socketPath: policy.gatewaySocket }
          : { hostname: address.value.address, family: address.value.family, port: target.port }),
        path: target.path, method: incoming.method, headers: forwardHeaders(incoming.headers, target.authority),
        agent: false,
      }, response => {
        outgoing.writeHead(response.statusCode ?? 502, forwardHeaders(response.headers));
        response.pipe(outgoing);
        response.on("error", () => outgoing.destroy());
      });
      const deadline = setTimeout(() => upstream.destroy(new Error("Upstream connection timed out")), CONNECT_TIMEOUT_MS);
      upstream.on("socket", socket => {
        track(socket);
        socket.once("connect", () => clearTimeout(deadline));
      });
      upstream.once("close", () => clearTimeout(deadline));
      upstream.on("error", () => {
        if (!outgoing.headersSent) reject(502, "Upstream request failed or timed out");
        else outgoing.destroy();
      });
      incoming.on("error", () => upstream.destroy());
      outgoing.on("close", () => upstream.destroy());
      incoming.pipe(upstream);
    }).catch(() => reject(502, "Upstream request could not be created"));
    pending(operation);
  });
  server.on("connect", (incoming, client, head) => {
    const socket = client as Socket;
    const reject = (status: number, message: string) => {
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nSandbox egress: ${message}\n`);
    };
    if (policy.profile === "benchmark") { reject(403, "CONNECT is disabled for this profile"); return; }
    const parsed = parseSandboxProxyTarget("CONNECT", incoming.url ?? "");
    if (!parsed.ok) { reject(403, parsed.error.message); return; }
    if (resolvers.size >= MAX_CONNECTIONS) { reject(503, "Too many concurrent requests"); return; }
    const operation = resolveSandboxAddress(parsed.value.hostname).then(address => {
      if (closed || socket.destroyed) return;
      if (!address.ok) { reject(address.error.code === "egress-denied" ? 403 : 502, address.error.message); return; }
      const upstream = connect({ host: address.value.address, family: address.value.family, port: parsed.value.port });
      track(upstream);
      const deadline = setTimeout(() => upstream.destroy(new Error("Upstream connection timed out")), CONNECT_TIMEOUT_MS);
      upstream.once("connect", () => {
        clearTimeout(deadline);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.once("close", () => { clearTimeout(deadline); socket.destroy(); });
      upstream.on("error", () => reject(502, "Upstream connection failed or timed out"));
      socket.once("close", () => upstream.destroy());
    }).catch(() => reject(502, "Upstream connection could not be created"));
    pending(operation);
  });
  function pending(operation: Promise<unknown>) {
    resolvers.add(operation);
    void operation.finally(() => resolvers.delete(operation));
  }
  function track(socket: Socket) {
    sockets.add(socket);
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
    const lifetime = setTimeout(() => socket.destroy(), LIFETIME_MS);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => { clearTimeout(lifetime); sockets.delete(socket); });
  }
  server.on("connection", socket => {
    // Upstream sockets are also tracked, so this bounds both DNS jobs and memory.
    if (closed || sockets.size >= MAX_CONNECTIONS * 2) { socket.destroy(); return; }
    track(socket);
  });
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
  server.on("error", () => {
    closed = true;
    for (const socket of sockets) socket.destroy();
  });
  async function close() {
    closed = true;
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.all(resolvers);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  try {
    directory = await mkdtemp(join(tmpdir(), "pi-sandbox-egress-"));
    await chmod(directory, 0o700);
    const socketPath = join(directory, "proxy.sock");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); });
    });
    await chmod(socketPath, 0o600);
    return { ok: true, value: { socketPath, close } };
  } catch (error) {
    await close();
    return { ok: false, error: { code: "egress-start-failed", message: `Cannot start sandbox download proxy: ${error instanceof Error ? error.message : String(error)}` } };
  }
}
