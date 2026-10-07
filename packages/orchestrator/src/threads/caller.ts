/**
 * Who is calling a local thread API, and what that caller may claim.
 *
 * Thread owners listen on loopback. Before September 28, 2026 they believed
 * whatever a request said: any local process could create a thread under any
 * parent, send as any thread, or create a root that looked like a person's
 * conversation. Hosts that grant different authority by thread origin (Converge
 * limits autonomous sessions) could then be escaped by one HTTP request.
 *
 * Each request now resolves to a caller, and the owner stamps what it verified
 * as `metadata.createdBy` on every thread it creates. Clients cannot set it.
 *
 * - `thread`: the request carries `x-pi-thread-token`, the thread capability
 *   the owner put in that session's environment as `PI_THREAD_TOKEN`.
 * - `runtime` / `service`: the loopback peer is a Pi Stack process itself, a
 *   shared thread runner or an owner service, and not something a thread's
 *   tools started. These are trusted to claim the thread they act for.
 * - `person`: a front door vouched for a human: the local router (root) or an
 *   upstream router presenting a credential this host trusts.
 * - `process`: anything else, identified by uid, pid and command, plus the
 *   host's optional attestation of that process.
 *
 * A local process may not name a parent or an agent sender, and a thread may
 * only name itself. Everything runs as the person's own Unix user,
 * so a caller that deliberately reads another thread's environment or the key
 * file can still impersonate it; this boundary stops ordinary API use from
 * forging custody, not a determined process with the same uid.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SendThread, SpawnThread } from "./contracts.js";
import { assertNever } from "./runtime-events.js";

export const THREAD_TOKEN_HEADER = "x-pi-thread-token";
export const UPSTREAM_CREDENTIAL_HEADER = "x-pi-remote-upstream";
const TOKEN_PREFIX = "pit1.";

export type ThreadCreator =
  | { kind: "thread"; threadId: string }
  | { kind: "person"; via: "router" | "upstream" }
  | { kind: "runtime" }
  | { kind: "service" }
  | { kind: "process"; uid: number; pid?: number; command?: string; attestation?: unknown };

export type ThreadCaller =
  | { kind: "thread"; threadId: string }
  | { kind: "runtime"; pid: number }
  | { kind: "service"; pid: number }
  | { kind: "person"; via: "router" | "upstream" }
  | { kind: "process"; uid: number; pid?: number; command?: string };

export interface ThreadCapability {
  issue(threadId: string): string;
  verify(token: string): string | undefined;
}

export function defaultCapabilityKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_THREAD_CAPABILITY_KEY ?? join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local/state"), "pi-stack/thread-capability.key");
}

/** One key per Unix user, shared by that user's Remote supervisor and Orchestrator daemon. */
export function threadCapability(keyPath = defaultCapabilityKeyPath()): ThreadCapability {
  let key: Buffer | undefined;
  const load = (): Buffer => {
    if (key) return key;
    if (!existsSync(keyPath)) {
      mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
      try {
        const fd = openSync(keyPath, "wx", 0o600);
        try { writeSync(fd, randomBytes(32).toString("hex")); } finally { closeSync(fd); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const text = readFileSync(keyPath, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`Thread capability key ${keyPath} is malformed`);
    return key = Buffer.from(text, "hex");
  };
  const mac = (threadId: string) => createHmac("sha256", load()).update(`pi-thread:${threadId}`).digest("base64url");
  return {
    issue: threadId => `${TOKEN_PREFIX}${threadId}.${mac(threadId)}`,
    verify(token) {
      if (!token.startsWith(TOKEN_PREFIX)) return undefined;
      const split = token.lastIndexOf(".");
      const threadId = token.slice(TOKEN_PREFIX.length, split), supplied = Buffer.from(token.slice(split + 1));
      if (!threadId || split <= TOKEN_PREFIX.length) return undefined;
      const expected = Buffer.from(mac(threadId));
      return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? threadId : undefined;
    },
  };
}

export interface HostIdentityConfig {
  /** Command run with the peer pid appended; its JSON output is stored as the creator's attestation. */
  callerAttestation?: string[];
  /** SHA-256 hex digests of upstream router credentials this host accepts as a person's front door. */
  upstreamCredentials?: string[];
}

export function hostIdentityConfig(path = process.env.PI_STACK_HOST_CONFIG ?? process.env.PI_STACK_HOST_FILE ?? "/etc/pi-stack/host.json"): HostIdentityConfig {
  if (!existsSync(path)) return {};
  const host = JSON.parse(readFileSync(path, "utf8"));
  const attestation = host.callerAttestation, upstream = host.upstreamCredentials;
  if (attestation !== undefined && (!Array.isArray(attestation) || !attestation.length || attestation.some((part: unknown) => typeof part !== "string" || !part)))
    throw new Error(`${path}: callerAttestation must be a non-empty command list`);
  if (upstream !== undefined && (!Array.isArray(upstream) || upstream.some((hash: unknown) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))))
    throw new Error(`${path}: upstreamCredentials must list SHA-256 hex digests`);
  return { ...(attestation ? { callerAttestation: attestation } : {}), ...(upstream ? { upstreamCredentials: upstream } : {}) };
}

// ---------------------------------------------------------------------------
// Loopback peer identity (Linux /proc)

export interface PeerSocket { address: string; port: number; localAddress: string; localPort: number }
export interface PeerProcess { uid: number; pid?: number }

function hexAddress(address: string, six: boolean): string | undefined {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const v4 = /^\d+\.\d+\.\d+\.\d+$/.test(address) ? address : mapped;
  const word = (bytes: number[]) => bytes.slice().reverse().map(byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  if (!six) return v4 ? word(v4.split(".").map(Number)) : undefined;
  if (v4) return `0000000000000000FFFF0000${word(v4.split(".").map(Number))}`;
  if (address === "::1") return "00000000000000000000000001000000";
  return undefined;
}

/** The uid and, when readable, pid owning the client end of a loopback TCP connection. */
export function loopbackPeer(socket: PeerSocket, proc = "/proc", identifyProcess = true): PeerProcess | undefined {
  for (const six of [false, true]) {
    const client = hexAddress(socket.address, six), server = hexAddress(socket.localAddress, six);
    if (!client || !server) continue;
    const local = `${client}:${socket.port.toString(16).toUpperCase().padStart(4, "0")}`;
    const remote = `${server}:${socket.localPort.toString(16).toUpperCase().padStart(4, "0")}`;
    let table: string;
    try { table = readFileSync(join(proc, "net", six ? "tcp6" : "tcp"), "utf8"); } catch { continue; }
    for (const line of table.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[1] !== local || fields[2] !== remote) continue;
      const uid = Number(fields[7]), inode = fields[9];
      return { uid, ...(identifyProcess && inode && inode !== "0" ? { pid: socketOwner(inode, uid, proc) } : {}) };
    }
  }
  return undefined;
}

function socketOwner(inode: string, uid: number, proc: string): number | undefined {
  const target = `socket:[${inode}]`;
  for (const entry of readdirSync(proc)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (statSync(join(proc, entry)).uid !== uid) continue;
      for (const fd of readdirSync(join(proc, entry, "fd"))) {
        try { if (readlinkSync(join(proc, entry, "fd", fd)) === target) return Number(entry); } catch { /* closed */ }
      }
    } catch { /* exited or unreadable */ }
  }
  return undefined;
}

function argv(pid: number, proc: string): string[] {
  try { return readFileSync(join(proc, String(pid), "cmdline")).toString().split("\0").filter(Boolean); } catch { return []; }
}
function parent(pid: number, proc: string): number {
  try { return Number(/^PPid:\s+(\d+)/m.exec(readFileSync(join(proc, String(pid), "status"), "utf8"))?.[1] ?? 0); } catch { return 0; }
}

const RUNNER = /\/dist\/threads\/runner-host\.js$/;
const SUPERVISOR = /\/(?:pi-remote|apps\/remote)\/server\/main\.ts$/;
const DAEMON = /\/(?:pi-orchestrator|orchestrator)\/(?:dist\/cli\.js|src\/cli\.ts)$/;
export function piProcessRole(args: string[]): "runtime" | "service" | undefined {
  if (args.some(arg => RUNNER.test(arg))) return "runtime";
  if (args.some(arg => SUPERVISOR.test(arg))) return "service";
  if (args.some(arg => DAEMON.test(arg)) && args.includes("daemon")) return "service";
  return undefined;
}

/**
 * Classify a loopback peer. A Pi Stack process counts only when no thread
 * runner is among its ancestors: a thread's tools cannot start a runner or a
 * supervisor and borrow its trust.
 */
export function peerCaller(peer: PeerProcess | undefined, options: { selfUid?: number; proc?: string } = {}): ThreadCaller {
  const proc = options.proc ?? "/proc", selfUid = options.selfUid ?? process.getuid?.() ?? -1;
  if (!peer) return { kind: "process", uid: -1 };
  if (peer.uid === 0 && selfUid !== 0) return { kind: "person", via: "router" };
  if (!peer.pid) return { kind: "process", uid: peer.uid };
  const own = argv(peer.pid, proc), role = piProcessRole(own);
  const command = own.join(" ").slice(0, 400);
  if (!role) return { kind: "process", uid: peer.uid, pid: peer.pid, command };
  const seen = new Set([peer.pid]);
  for (let pid = parent(peer.pid, proc); pid > 1 && !seen.has(pid); pid = parent(pid, proc)) {
    seen.add(pid);
    if (argv(pid, proc).some(arg => RUNNER.test(arg))) return { kind: "process", uid: peer.uid, pid: peer.pid, command };
  }
  return { kind: role, pid: peer.pid };
}

export interface CallerSource {
  headers: Headers;
  socket?: PeerSocket;
}

export interface CallerResolver {
  resolve(source: CallerSource): ThreadCaller | { error: string };
  admit(operation: string, input: Record<string, any>, caller: ThreadCaller): Promise<AdmissionResult>;
}

export type AdmissionResult = { ok: true; input: Record<string, any> } | { ok: false; status: number; message: string };

export interface CallerResolverOptions {
  capability: ThreadCapability;
  host?: HostIdentityConfig;
  /** Tests replace /proc inspection. */
  peer?: (socket: PeerSocket) => ThreadCaller;
  attest?: (pid: number) => Promise<unknown>;
}

function attestation(command: string[], pid: number): Promise<unknown> {
  return new Promise(resolve => {
    execFile(command[0]!, [...command.slice(1), String(pid)], { timeout: 20_000, maxBuffer: 1 << 20 }, (error, stdout) => {
      try {
        const value = JSON.parse(stdout);
        resolve(value && typeof value === "object" ? value : { error: "attestation printed no JSON object" });
      } catch { resolve({ error: error ? String(error.message).slice(0, 400) : "attestation printed no JSON object" }); }
    });
  });
}

/** The creator a verified caller stamps on a thread it creates. */
export function creatorOf(caller: ThreadCaller, parentId?: string, forwarded?: unknown): ThreadCreator {
  switch (caller.kind) {
    case "thread": return { kind: "thread", threadId: caller.threadId };
    case "runtime": return parentId ? { kind: "thread", threadId: parentId } : { kind: "runtime" };
    case "service": return isCreator(forwarded) ? forwarded : parentId ? { kind: "thread", threadId: parentId } : { kind: "service" };
    case "person": return { kind: "person", via: caller.via };
    case "process": return { kind: "process", uid: caller.uid, ...(caller.pid ? { pid: caller.pid } : {}), ...(caller.command ? { command: caller.command } : {}) };
  }
  return assertNever(caller);
}

function isCreator(value: unknown): value is ThreadCreator {
  const kind = (value as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" && ["thread", "person", "runtime", "service", "process"].includes(kind);
}

const refuse = (message: string): AdmissionResult => ({ ok: false, status: 403, message });

export function callerResolver(options: CallerResolverOptions): CallerResolver {
  const host = options.host ?? {};
  const peer = options.peer ?? ((socket: PeerSocket) => peerCaller(loopbackPeer(socket)));
  const attest = options.attest ?? (host.callerAttestation ? (pid: number) => attestation(host.callerAttestation!, pid) : undefined);
  return {
    resolve({ headers, socket }) {
      const token = headers.get(THREAD_TOKEN_HEADER);
      if (token) {
        const threadId = options.capability.verify(token);
        return threadId ? { kind: "thread", threadId } : { error: "The thread capability is not valid for this owner" };
      }
      const upstream = headers.get(UPSTREAM_CREDENTIAL_HEADER);
      if (upstream) {
        const digest = createHash("sha256").update(upstream).digest("hex");
        return host.upstreamCredentials?.includes(digest) ? { kind: "person", via: "upstream" } : { error: "The upstream router credential is not trusted here" };
      }
      if (!socket) return { kind: "process", uid: -1 };
      return peer(socket);
    },
    async admit(operation, input, caller) {
      if (operation === "control") {
        if ((input.action === "dependencyClaim" || input.action === "dependencyRelease") && caller.kind !== "runtime" && caller.kind !== "service") return refuse("Dependency endpoint reservations require an owning runtime or service");
        if (input.action === "open" || input.action === "placement" || input.action === "view") {
          if (caller.kind !== "person" && caller.kind !== "service") return refuse("Only a human opening or placing an agent can change foreground placement");
        }
        if (input.action === "dependencies" && caller.kind === "thread" && input.threadId !== caller.threadId)
          return refuse("Only the dependent agent can resolve or release its outgoing dependencies");
        if (input.action === "dependencies" && caller.kind !== "thread" && caller.kind !== "runtime" && caller.kind !== "service")
          return refuse("Dependency changes require the dependent agent's capability or owning runtime");
      }
      if (operation === "agentWait" || operation === "wakeSchedule") {
        if (caller.kind === "thread" && input.threadId !== caller.threadId) return refuse(`Thread ${caller.threadId} can only manage its own waiting and wakes`);
        if (caller.kind !== "thread" && caller.kind !== "runtime" && caller.kind !== "service") return refuse("Self waiting and wakes require a thread capability or the Pi runtime");
      }
      if (operation === "attention") {
        if (caller.kind === "thread" && input.threadId !== caller.threadId) return refuse(`Thread ${caller.threadId} can only request attention for itself`);
        if (caller.kind !== "thread" && caller.kind !== "runtime" && caller.kind !== "service") return refuse("Self attention requires a thread capability or the Pi runtime");
      }
      if (operation === "watch") {
        if (caller.kind === "thread" && input.threadId !== caller.threadId) return refuse(`Thread ${caller.threadId} can only edit the watch list as itself`);
        if (caller.kind === "process") return refuse("Watch list access requires a thread capability or the Pi runtime");
      }
      if (operation === "spawn") {
        const { createdBy: forwarded, ...request } = input as SpawnThread & { createdBy?: unknown };
        if (request.metadata && typeof request.metadata === "object" && "createdBy" in request.metadata) {
          const { createdBy: _ignored, ...metadata } = request.metadata as Record<string, unknown>;
          request.metadata = metadata;
        }
        if (request.parentId !== undefined && request.parentId !== null) {
          if (caller.kind === "thread" && request.parentId !== caller.threadId) return refuse(`Thread ${caller.threadId} can only create its own children`);
          if (caller.kind === "process") return refuse("Naming a parent requires that thread's capability (PI_THREAD_TOKEN) or the Pi runtime");
        }
        if (caller.kind === "thread") request.parentId = caller.threadId;
        let createdBy = creatorOf(caller, request.parentId ?? undefined, forwarded);
        if (createdBy.kind === "process" && createdBy.pid && attest) createdBy = { ...createdBy, attestation: await attest(createdBy.pid) };
        return { ok: true, input: { ...request, createdBy } };
      }
      if (operation === "send") {
        const request = input as SendThread;
        if (request.senderId !== undefined && request.senderId !== null && request.senderId !== "") {
          if (caller.kind === "thread" && request.senderId !== caller.threadId) return refuse(`Thread ${caller.threadId} can only send as itself`);
          // A person reached this owner through an authenticated front door; root runners (root repair) also arrive as uid 0.
          if (caller.kind === "process") return refuse("Sending as a thread requires that thread's capability (PI_THREAD_TOKEN) or the Pi runtime");
        } else if (caller.kind === "thread") return refuse("A thread sends as itself; set senderId to the calling thread");
      }
      return { ok: true, input };
    },
  };
}

/** The per-request admission a thread HTTP boundary applies; the caller is resolved only for spawn and send. */
export function admissionFor(resolver: CallerResolver, source: CallerSource): (operation: string, input: Record<string, any>) => Promise<AdmissionResult> {
  let caller: ThreadCaller | { error: string } | undefined;
  return async (operation, input) => {
    if (operation !== "control" && operation !== "spawn" && operation !== "send" && operation !== "watch" && operation !== "agentWait" && operation !== "wakeSchedule" && operation !== "attention") return { ok: true, input };
    caller ??= resolver.resolve(source);
    if ("error" in caller) return { ok: false, status: 401, message: caller.error };
    return resolver.admit(operation, input, caller);
  };
}
