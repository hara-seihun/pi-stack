import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CoreCustody } from "../core/contracts.js";
import { CustodyResources } from "../core/custody-resources.js";
import { runnerSlices, BOUNDARY_MEMORY, TOOLS_MEMORY } from "./runner-resources.js";
const execute = promisify(execFile);
import { createHash } from "node:crypto";
import { setMaxListeners } from "node:events";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { AttachPiSession, OpenPiSession, PiCommand, PiEvent, PiRunnerReference, PiSession, PiSessionOptions } from "./contracts.js";
import { underMemoryPressure } from "./runner-memory.js";
import { RunnerStartupError } from "./runner-startup.js";
import { isolatePiEnvironment } from "./pi-environment.js";
import { prepareRunnerSlices, managerCommand, newRunnerUnit, RUNNER_MEMORY, RUNNER_HEAP_MB } from "./runner-resources.js";
import { assertNever, requireRuntimeEvent } from "./runtime-events.js";
import { requireRunnerFrame, type RunnerFrame } from "./runner-protocol.js";

interface Connection { send(command: PiCommand): void; detach(): void }
const starts = new Map<string, Promise<void>>();
function socketAbsent(error: unknown): boolean {
  const failure = error as NodeJS.ErrnoException;
  return failure?.syscall === "connect" && ["ENOENT", "ECONNREFUSED"].includes(failure.code ?? "");
}
function runnerRequest(path: string, value: unknown, timeout = 5000, signal?: AbortSignal, connector: (path: string) => Socket = createConnection): Promise<any> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const socket = connector(path);
    const abort = () => socket.destroy(new Error("Runner observation detached; native command custody is unchanged"));
    signal?.addEventListener("abort", abort, { once: true });
    let input = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Thread runner control timed out")); }, timeout);
    socket.on("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on("data", chunk => {
      input += chunk.toString();
      const end = input.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer); socket.end();
      try { const response = JSON.parse(input.slice(0, end)); response.error ? reject(response.nativeNotReady === true ? new RunnerStartupError(response.error) : new Error(response.error)) : resolve(response); }
      catch (error) { reject(error); }
    });
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("close", () => { signal?.removeEventListener("abort", abort); clearTimeout(timer); reject(new Error("Thread runner control closed")); });
  });
}
function connect(path: string, output: (event: PiEvent) => void, exit: (code: number) => void, onAttached: () => void, signal?: AbortSignal, connector: (path: string) => Socket = createConnection): Promise<Connection> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let socket: Socket;
    let connected = false, attached = false, detached = false, ended = false;
    let sequence = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const unsent: string[] = [];
    const connection: Connection = {
      send(command) {
        if (detached || ended) throw new Error("Thread runner connection is detached");
        const line = `${JSON.stringify({ type: "command", value: command })}\n`;
        if (connected && socket.writable) socket.write(line); else unsent.push(line);
      },
      detach() { detached = true; clearTimeout(retry); socket?.destroy(); unsent.length = 0; signal?.removeEventListener("abort", abort); },
    };
    const abort = () => { connection.detach(); reject(new Error("Runner stream detached; execution remains native-owned")); };
    signal?.addEventListener("abort", abort, { once: true });
    function finish(code = 1) { if (!ended) { ended = true; clearTimeout(retry); exit(code); } }
    function open() {
      if (detached || ended) return;
      const current = socket = connector(path);
      // A runner's output line can be megabytes (tool results, images). Keep a
      // partial line as chunks and scan only new text: rescanning and re-slicing
      // the whole buffer on every 64 KiB chunk held the daemon at a full core.
      let partial: string[] = [];
      const decoder = new StringDecoder("utf8");
      connected = false;
      const timer = setTimeout(() => current.destroy(new Error("Thread runner attach timed out")), 5000);
      current.setNoDelay(true);
      current.on("connect", () => current.write(`${JSON.stringify({ type: "attach", after: sequence })}\n`));
      function acceptFrame(value: RunnerFrame): void {
        switch (value.type) {
          case "attached":
            if (!attached) onAttached();
            attached = true; connected = true; clearTimeout(timer);
            for (const line of unsent.splice(0)) current.write(line);
            resolve(connection); return;
          case "output": {
            const next = value.sequence;
            if (next <= sequence) return;
            const event = requireRuntimeEvent(JSON.parse(value.line));
            if (value.at !== undefined && event.emittedAt === undefined) event.emittedAt = value.at;
            output(event);
            sequence = next;
            current.write(`${JSON.stringify({ type: "ack", sequence })}\n`);
            return;
          }
          case "exit": finish(value.code); return;
        }
        assertNever(value);
      }
      current.on("data", chunk => {
        if (current !== socket) return;
        const text = decoder.write(chunk);
        let start = 0, end: number;
        const lines: string[] = [];
        while ((end = text.indexOf("\n", start)) >= 0) {
          partial.push(text.slice(start, end));
          lines.push(partial.length === 1 ? partial[0]! : partial.join(""));
          partial = []; start = end + 1;
        }
        if (start < text.length) partial.push(text.slice(start));
        for (const line of lines) {
          if (current !== socket || current.destroyed) return;
          if (!line) continue;
          try {
            acceptFrame(requireRunnerFrame(JSON.parse(line)));
          } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            if (!attached) { ended = true; clearTimeout(timer); reject(failure); }
            else {
              try { output({ type: "thread_error", error: `Runner protocol failure: ${failure.message}` }); }
              finally { finish(1); current.destroy(failure); }
            }
            current.destroy(failure);
          }
        }
      });
      current.on("end", () => current.destroy());
      current.on("error", (error: NodeJS.ErrnoException) => {
        if (!attached) reject(error);
        else if (socketAbsent(error)) finish();
      });
      current.on("close", () => {
        clearTimeout(timer); connected = false;
        if (!attached) reject(new Error(`Thread runner closed before attach: ${path}`));
        else if (!detached && !ended) retry = setTimeout(open, 25);
      });
    }
    open();
  });
}
function hash(value: string) { return createHash("sha256").update(value).digest("hex").slice(0, 16); }
function executable(name: string, path: string | undefined): string {
  for (const directory of (path ?? "").split(":")) {
    if (!directory) continue;
    const candidate = resolve(directory, name);
    try { accessSync(candidate, constants.X_OK); return candidate; }
    catch (error) { if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  throw new Error(`Thread runner requires ${name} on its configured PATH`);
}
// Bun imports the source API; the shared runner always executes compiled code in Node.
export function runnerHostEntry(moduleUrl = import.meta.url): string {
  return fileURLToPath(new URL(moduleUrl.endsWith(".ts") ? "../../dist/threads/runner-host.js" : "./runner-host.js", moduleUrl));
}
export function userManagerEnvironment(uid: number) {
  const runtimeDir = `/run/user/${uid}`;
  return { XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` };
}
function boundary(options: PiSessionOptions, custody?: CoreCustody) {
  const isolation = options.args.includes("--orchestrator-context") ? `isolated:${options.cwd}` : "normal";
  return hash(JSON.stringify([custody ? ["shared-core-native-v1", custody.namespace] : import.meta.url, custody?.uid ?? process.getuid?.(), options.env.HOME ?? process.env.HOME, options.env.PI_CODING_AGENT_DIR ?? "", options.env.PI_ORCHESTRATOR_EXECUTION ?? "user", options.env.PI_MODEL_BROKER_URL ?? "direct", isolation]));
}
async function ensureRunner(control: string, options: PiSessionOptions, durable: boolean, currentGeneration = true, signal?: AbortSignal, resources?: CustodyResources): Promise<void> {
  signal?.throwIfAborted();
  const observed = control;
  const connector = resources ? (path: string) => resources.connection(path) : createConnection;
  const present = () => resources ? resources.exists(control) : existsSync(control);
  const manager = async (args: string[], env: NodeJS.ProcessEnv, user: boolean) => {
    if (!resources) return managerCommand(args, env, user);
    const command = resources.launch(["/usr/bin/systemctl", ...(user ? ["--user"] : []), ...args]);
    return execute(command[0]!, command.slice(1), { env, timeout: 5000, maxBuffer: 64 * 1024 });
  };
  if (present()) {
    try { await runnerRequest(observed, { type: currentGeneration ? "retain" : "status" }, 5000, signal, connector); return; }
    catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  if (underMemoryPressure()) throw new Error("Runner capacity busy: memory pressure");
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, PI_THREAD_RUNNER_RESIDENT: !currentGeneration || options.args.includes("--orchestrator-context") ? "0" : "1" };
  const broker = !!options.env.PI_MODEL_BROKER_URL;
  const brokerSecrets = ["PI_ORCHESTRATOR_AUTH", "PI_ORCHESTRATOR_OWNER_UID", "PI_ORCHESTRATOR_OWNER_GID", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
  if (broker) for (const key of brokerSecrets) delete env[key];
  if (options.args.includes("--orchestrator-context")) {
    isolatePiEnvironment(options.cwd, env);
    if (resources) {
      const command = resources.launch(["/usr/bin/mkdir", "-p", "--mode=700", "--", env.HOME!]);
      await execute(command[0]!, command.slice(1), { env, timeout: 5000, maxBuffer: 64 * 1024 });
    } else mkdirSync(env.HOME!, { recursive: true, mode: 0o700 });
  }
  for (const key of Object.keys(env)) if (/^(PI_REMOTE_SESSION_ID|PI_THREAD_ID|PI_THREAD_TOKEN|PI_THREAD_REQUIRE_SESSION|PI_THREAD_CAN_SPAWN|PI_THREAD_SPEED|PI_THREAD_MODE|PI_THREAD_LIVE_DISPATCHER|PI_THREAD_USAGE|PI_THREAD_ADMISSION|PI_THREAD_SESSION_KEY|PI_THREAD_RECOVERING|PI_THREAD_RUNNER_REFERENCE|PI_ORCHESTRATOR_ACCOUNT_ID|PI_ORCHESTRATOR_PROVIDER|PI_ORCHESTRATOR_ASSIGNED|PI_SUBAGENT_MODEL|PI_REMOTE_MEETING_ID|PI_REMOTE_SERVICE_TIER_FILE|PI_ORCHESTRATOR_RUN_ID|PI_SESSION_FILE)$/.test(key)) delete env[key];
  const entry = runnerHostEntry();
  if (!existsSync(entry)) throw new Error(`Compiled thread runner is missing: ${entry}; build pi-orchestrator before starting threads`);
  const root = options.env.PI_ORCHESTRATOR_EXECUTION === "root-repair";
  if (root && broker) throw new Error("Root repair cannot use a model-broker execution boundary");
  if (root && (!durable || options.args.includes("--orchestrator-context"))) throw new Error("Root repair requires the fleet execution boundary without isolated context");
  if (root) { env.PI_ORCHESTRATOR_OWNER_UID = String(resources?.custody.uid ?? process.getuid!()); env.PI_ORCHESTRATOR_OWNER_GID = String(resources?.custody.gid ?? process.getgid!()); }
  delete env.PI_THREAD_RESOURCE_BOUNDARY;
  delete env.PI_THREAD_RUNNER_UNIT;
  const resourceId = hash(control), unit = resources ? newRunnerUnit(resourceId).replace(/\.service$/, ".scope") : newRunnerUnit(resourceId);
  const command = [executable("flock", env.PATH), "--no-fork", "--nonblock", "--conflict-exit-code", "75", `${control}.lock`, executable("node", env.PATH), `--max-old-space-size=${durable ? RUNNER_HEAP_MB : 8192}`, "--expose-gc", entry, control];
  if (durable) {
    if (!root) Object.assign(env, userManagerEnvironment(resources?.custody.uid ?? process.getuid!()));
    env.PI_THREAD_RESOURCE_BOUNDARY = resourceId;
    env.PI_THREAD_RUNNER_UNIT = unit;
    const slices = resources ? runnerSlices(resourceId) : await prepareRunnerSlices(resourceId, env, !root);
    if (resources) for (const [slice, memory] of [[slices.boundary, BOUNDARY_MEMORY], [slices.tools, TOOLS_MEMORY]])
      await manager(["set-property", "--runtime", slice!, `MemoryHigh=${memory}`, `MemoryMax=${memory}`, "MemorySwapMax=256M"], env, !root);
    const validKey = (key: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
    const unset = [...new Set([...Object.keys(process.env).filter(key => validKey(key) && !(key in env)), ...(broker ? brokerSecrets : [])])];
    command.unshift("systemd-run", ...(root ? [] : ["--user"]), "--collect", "--quiet",
      ...(resources ? ["--scope"] : ["--wait", "--service-type=exec", "--property=KillMode=control-group", "--property=OOMPolicy=continue"]),
      `--slice=${slices.boundary}`, `--property=MemoryHigh=${RUNNER_MEMORY}`, `--property=MemoryMax=${RUNNER_MEMORY}`, "--property=MemorySwapMax=256M",
      `--working-directory=${env.HOME}`,
      ...(resources ? [] : Object.keys(env).filter(key => validKey(key) && env[key] !== undefined).map(key => `--setenv=${key}`)),
      ...(!resources && unset.length ? [`--property=UnsetEnvironment=${unset.join(" ")}`] : []),
      `--unit=${unit}`);
  }
  if (root) command.unshift("sudo", "-n", "--preserve-env");
  signal?.throwIfAborted();
  const launch = resources ? resources.launch(command) : command;
  const host = spawn(launch[0]!, launch.slice(1), {
    cwd: resources ? undefined : env.HOME, detached: true, stdio: ["ignore", "inherit", "inherit"], env,
  });
  host.unref();
  let launchError: Error | undefined;
  host.on("error", error => { launchError = error; });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (launchError) throw launchError;
    if (host.exitCode !== null && host.exitCode !== 75) throw new Error(`Thread runner exited ${host.exitCode}`);
    if (present()) {
      try {
        const status = await runnerRequest(observed, { type: "status" }, 5000, signal, connector);
        if (durable) {
          // A concurrent launch may have won the control lock; its owner names the live unit.
          if (typeof status.unit !== "string") throw new Error("Durable thread runner did not report its controller unit");
          await manager(["set-property", "--runtime", status.unit,
            `MemoryHigh=${RUNNER_MEMORY}`, `MemoryMax=${RUNNER_MEMORY}`, "MemorySwapMax=256M"], env, !root);
        }
        return;
      }
      catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
    await delay(25, undefined, { signal });
  }
  throw new Error("Thread runner startup has not acknowledged ownership");
}

export function runnerSocketDirectory(dataDir: string, uid = process.getuid!()): string {
  const absolute = resolve(dataDir);
  const longest = join(absolute, "thread-sockets", `${"0".repeat(16)}.${"0".repeat(16)}.sock`);
  // Managed OIDC homes exceed Linux's 107-byte pathname limit for Unix sockets.
  return Buffer.byteLength(longest) <= 107 ? absolute : `/run/user/${uid}/pi/${hash(absolute)}`;
}

export class RunnerRecoveryError extends Error {
  constructor(readonly code: "ownership-uncertain" | "ownership-conflict", message: string) { super(message); this.name = "RunnerRecoveryError"; }
}

function controlOwnerAbsent(control: string, resources?: CustodyResources): boolean {
  let lock: { dev: number | string; ino: number | string } | null;
  try { lock = resources ? resources.identity(`${control}.lock`) : statSync(`${control}.lock`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
  if (!lock) return true;
  const dev = BigInt(lock.dev);
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  // An unlocked file is not ownership; flock keeps the lock for the native process lifetime.
  return !readFileSync("/proc/locks", "utf8").split("\n").some(line => {
    const fields = line.trim().split(/\s+/);
    const identity = fields[5]?.split(":");
    return fields[1] === "FLOCK" && identity?.length === 3 &&
      BigInt(`0x${identity[0]}`) === major && BigInt(`0x${identity[1]}`) === minor && BigInt(identity[2]!) === BigInt(lock.ino);
  });
}

export function createSharedPiSessionOpener({ dataDir, durable = false, custody, resources }: { dataDir: string; durable?: boolean; custody?: CoreCustody; resources?: CustodyResources }): { openSession: OpenPiSession; attachSession: AttachPiSession; recoverSession(threadId: string, output: (event: PiEvent) => void, exit: (code: number | null) => void): Promise<PiSession | null>; detach(): void } {
  if ((custody === undefined) !== (resources === undefined)) throw new Error("Registered custody and pinned resources must be supplied together");
  if (custody && (custody.dataDir !== dataDir || resources!.custody !== custody)) throw new Error("Runner custody does not match its registered resources");
  const socketDir = custody?.socketDir ?? runnerSocketDirectory(dataDir);
  const retainedResources = custody && resources && JSON.stringify(custody.retainedRunnerNamespace) !== JSON.stringify(custody.namespace)
    ? new CustodyResources({ ...custody, namespace: custody.retainedRunnerNamespace }) : resources;
  const targets: CustodyResources[] = [];
  const namespaces = new Set<string>();
  for (const target of [resources, retainedResources]) {
    if (!target || targets.includes(target)) continue;
    const namespace = target.custody.namespace;
    const identity = `${target.custody.uid}:${namespace.kind === "host" ? statSync("/proc/1/ns/mnt", { bigint: true }).ino : namespace.mountNamespaceInode}`;
    if (namespaces.has(identity)) { target.close(); continue; }
    namespaces.add(identity); targets.push(target);
  }
  const routes = new Map<string, CustodyResources>();
  const controlFor = (path: string) => dirname(path) === join(socketDir, "thread-runners") ? path.replace(/\.lock$/, "")
    : join(socketDir, "thread-runners", `${path.slice(path.lastIndexOf("/") + 1, path.lastIndexOf("/") + 17)}.sock`);
  const absentOwner = (control: string) => targets.length ? targets.every(target => controlOwnerAbsent(control, target)) : controlOwnerAbsent(control);
  const present = (path: string) => {
    const target = routes.get(controlFor(path));
    return target ? target.exists(path) : targets.length ? targets.some(target => target.exists(path)) : existsSync(path);
  };
  const connector = (path: string) => {
    const target = routes.get(controlFor(path));
    if (targets.length && !target) throw new RunnerRecoveryError("ownership-uncertain", "Native namespace ownership has not been established");
    return target ? target.connection(path) : createConnection(path);
  };
  const startupKey = (control: string, target?: CustodyResources) => target ? `${target.custody.uid}:${JSON.stringify(target.custody.namespace)}:${control}` : control;
  const connections = new Set<Connection>();
  const controls = new Map<string, boolean>();
  const observation = new AbortController();
  setMaxListeners(0, observation.signal);
  const request = async (path: string, value: unknown, timeout = 5000) => {
    if (!targets.length || routes.has(controlFor(path))) return runnerRequest(path, value, timeout, observation.signal, connector);
    if ((value as { type?: string }).type !== "status") throw new RunnerRecoveryError("ownership-uncertain", "Native command has no proven namespace owner");
    const found: { target: CustodyResources; status: any }[] = [];
    for (const target of targets) {
      if (!target.exists(path)) continue;
      try { found.push({ target, status: await runnerRequest(path, value, timeout, observation.signal, logical => target.connection(logical)) }); }
      catch (error) { if (!socketAbsent(error)) throw error; }
    }
    if (found.length > 1) throw new RunnerRecoveryError("ownership-conflict", "Multiple registered namespaces acknowledge the same native control");
    if (!found.length) throw Object.assign(new Error("No registered namespace acknowledges native control"), { code: "ENOENT", syscall: "connect" });
    routes.set(path, found[0]!.target);
    return found[0]!.status;
  };
  function validate(reference: PiRunnerReference): PiRunnerReference {
    if (!reference || typeof reference.control !== "string" || typeof reference.socketPath !== "string") throw new Error("Invalid recorded runner reference");
    const control = resolve(reference.control), socketPath = resolve(reference.socketPath);
    if (dirname(control) !== join(socketDir, "thread-runners") || dirname(socketPath) !== join(socketDir, "thread-sockets")) throw new Error("Recorded runner is outside this execution boundary");
    return { control, socketPath };
  }
  async function attach({ control, socketPath }: PiRunnerReference, output: (event: PiEvent) => void, exit: (code: number) => void, residency = true): Promise<PiSession> {
    let connection: Connection | undefined;
    let exited = false;
    connection = await connect(socketPath, output, code => { exited = true; if (connection) connections.delete(connection); exit(code); }, () => output({ type: "runner_attached", control, socketPath }), observation.signal, connector);
    const attached = connection;
    if (!exited) connections.add(attached);
    controls.set(control, residency);
    return {
      command: async command => { attached.send(command); },
      setActive: async active => { if (residency) await request(control, { type: "activity", socketPath, active }); },
      close: async () => {
        await request(control, { type: "close", socketPath }, 35_000);
        attached.detach(); connections.delete(attached);
      },
    };
  }
  const attachSession: AttachPiSession = async (reference, output, exit) => {
    if (reference === undefined) return null;
    const recorded = validate(reference);
    let status: any;
    try { status = await request(recorded.control, { type: "status" }); }
    catch (error) {
      if (!socketAbsent(error)) throw error;
      if (!absentOwner(recorded.control)) throw new RunnerRecoveryError("ownership-uncertain", `Native runner still owns unreachable control: ${recorded.control}`);
      return null;
    }
    if (status?.ok !== true) throw new Error("Thread runner did not acknowledge status");
    try { return await attach(recorded, output, exit, typeof status.activeSessions === "number"); }
    catch (error) {
      if (!socketAbsent(error)) throw error;
      if (status.threadIds?.some((id: string) => recorded.socketPath.endsWith(`.${hash(id)}.sock`))) throw new RunnerRecoveryError("ownership-uncertain", `Native ownership remains without a session socket: ${recorded.socketPath}`);
      // Fence an earlier open whose acknowledgement was lost. Native close shares its serial queue.
      try { await request(recorded.control, { type: "close", socketPath: recorded.socketPath }, 35_000); }
      catch (closing) {
        if (!socketAbsent(closing)) throw closing;
        if (!absentOwner(recorded.control)) throw new RunnerRecoveryError("ownership-uncertain", `Native absence fence lost its owner: ${recorded.control}`);
      }
      return null;
    }
  };
  function generations(threadId: string): string[] {
    const found = new Set<string>();
    function entries(directory: string): string[] {
      try { return targets.length ? [...new Set(targets.flatMap(target => target.entries(directory)))] : readdirSync(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    }
    for (const name of entries(join(socketDir, "thread-runners"))) {
      const match = /^([a-f0-9]{16})\.sock(?:\.lock)?$/.exec(name);
      if (!match) throw new RunnerRecoveryError("ownership-uncertain", `Unrecognized native runner generation: ${name}`);
      found.add(match[1]!);
    }
    const suffix = `.${hash(threadId)}.sock`;
    for (const name of entries(join(socketDir, "thread-sockets"))) {
      if (!name.endsWith(suffix) && !name.endsWith(`${suffix}.events`)) continue;
      const generation = name.slice(0, 16);
      if (!/^[a-f0-9]{16}$/.test(generation) || !name.startsWith(`${generation}${suffix}`)) throw new RunnerRecoveryError("ownership-uncertain", `Unrecognized native session generation: ${name}`);
      found.add(generation);
    }
    for (const key of starts.keys()) {
      const control = key.slice(key.indexOf(join(socketDir, "thread-runners")));
      if (dirname(control) === join(socketDir, "thread-runners")) found.add(control.slice(control.lastIndexOf("/") + 1, -5));
    }
    return [...found].sort();
  }
  const recoverSession = async (threadId: string, output: (event: PiEvent) => void, exit: (code: number | null) => void): Promise<PiSession | null> => {
    const discovered = generations(threadId);
    const candidates: { reference: PiRunnerReference; residency: boolean }[] = [];
    for (const generation of discovered) {
      const reference = { control: join(socketDir, "thread-runners", `${generation}.sock`), socketPath: join(socketDir, "thread-sockets", `${generation}.${hash(threadId)}.sock`) };
      if (targets.length) await Promise.all(targets.map(target => starts.get(startupKey(reference.control, target))));
      else { const starting = starts.get(reference.control); if (starting) await starting; }
      let status: any;
      try { status = await request(reference.control, { type: "status" }); }
      catch (error) {
        if (!socketAbsent(error)) throw error;
        if (!absentOwner(reference.control) || present(reference.socketPath)) throw new RunnerRecoveryError("ownership-uncertain", `Cannot establish native absence: ${reference.control}`);
        continue;
      }
      if (status?.ok !== true || !Array.isArray(status.threadIds)) throw new RunnerRecoveryError("ownership-uncertain", `Native runner did not report thread ownership: ${reference.control}`);
      if (present(reference.socketPath)) {
        candidates.push({ reference, residency: typeof status.activeSessions === "number" });
        continue;
      }
      if (status.threadIds.includes(threadId)) throw new RunnerRecoveryError("ownership-uncertain", `Native thread owns a missing session socket: ${threadId}`);
      // Status is not serialized with open. Close fences an open still waiting in the native queue.
      try {
        const closed = await request(reference.control, { type: "close", socketPath: reference.socketPath }, 35_000);
        if (closed?.ok !== true) throw new RunnerRecoveryError("ownership-uncertain", `Native runner did not acknowledge absence fence: ${reference.control}`);
      } catch (error) {
        if (!socketAbsent(error)) throw error;
        if (!absentOwner(reference.control)) throw new RunnerRecoveryError("ownership-uncertain", `Native absence fence lost its owner: ${reference.control}`);
      }
      if (present(reference.socketPath)) throw new RunnerRecoveryError("ownership-uncertain", `Native session remains after absence fence: ${threadId}`);
    }
    if (candidates.length > 1) throw new RunnerRecoveryError("ownership-conflict", `Multiple native generations own thread ${threadId}`);
    if (generations(threadId).some(generation => !discovered.includes(generation))) throw new RunnerRecoveryError("ownership-uncertain", `Native generations changed during recovery: ${threadId}`);
    const candidate = candidates[0];
    if (!candidate) return null;
    return attach(candidate.reference, output, exit, candidate.residency);
  };
  const openSession: OpenPiSession = async (options, output, exit) => {
    let retained = options.env.PI_THREAD_RUNNER_REFERENCE ? validate(JSON.parse(options.env.PI_THREAD_RUNNER_REFERENCE)) : undefined;
    const group = boundary(options, custody);
    const currentControl = join(socketDir, "thread-runners", `${group}.sock`);
    if (retained && retained.control !== currentControl) {
      let status: any;
      try { status = await request(retained.control, { type: "status" }); }
      catch (error) { if (!socketAbsent(error)) throw error; }
      const recoveringLive = options.env.PI_THREAD_RECOVERING === "1" && status?.threadIds?.includes(options.threadId);
      // Request drain before closing the last idle resident: its close can remove the control socket.
      // Recovery keeps accepted sessions, not obsolete empty generations, even after a controller crash.
      if (typeof status?.activeSessions === "number") {
        try { await request(retained.control, { type: "drain" }); }
        catch (error) { if (!socketAbsent(error)) throw error; }
      }
      if (!recoveringLive && status && status.sessions !== 0) {
        try { await request(retained.control, { type: "close", socketPath: retained.socketPath }, 35_000); }
        catch (error) { if (!socketAbsent(error)) throw error; }
      }
      if (!recoveringLive) retained = undefined;
    }
    const control = retained?.control ?? currentControl;
    const socketPath = retained?.socketPath ?? join(socketDir, "thread-sockets", `${group}.${hash(options.threadId)}.sock`);
    const reference = validate({ control, socketPath });
    output({ type: "runner_attached", control, socketPath });
    const launchResources = retained ? routes.get(control) : resources;
    if (launchResources) routes.set(control, launchResources);
    if (launchResources) {
      const command = launchResources.launch(["/usr/bin/mkdir", "-p", "--mode=700", "--", dirname(control), dirname(socketPath)]);
      await execute(command[0]!, command.slice(1), { env: options.env, timeout: 5000, maxBuffer: 64 * 1024 });
    } else {
      mkdirSync(dirname(control), { recursive: true, mode: 0o700 });
      mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
    }
    const key = startupKey(control, launchResources);
    let starting = starts.get(key);
    if (!starting) {
      starting = ensureRunner(control, options, durable, control === currentControl, observation.signal, launchResources).finally(() => starts.delete(key));
      starts.set(key, starting);
    }
    await starting;
    const { threads: _threads, ...serializable } = options;
    if (!options.env.PI_THREAD_API_URL) throw new Error("Shared Pi sessions require their owning PI_THREAD_API_URL");
    await request(control, { type: "open", options: { ...serializable, socketPath, priority: options.env.PI_THREAD_ADMISSION !== "background" } }, 35_000);
    const status = retained ? await request(control, { type: "status" }) : undefined;
    return attach(reference, output, exit, !status || typeof status.activeSessions === "number");
  };
  return { openSession, attachSession, recoverSession, detach() {
    observation.abort(new Error("Runner controller detached; accepted execution remains native-owned"));
    for (const connection of connections) connection.detach(); connections.clear();
    const drains = [...controls].filter(([, residency]) => residency).map(([control]) => runnerRequest(control, { type: "drain" }, 5000, undefined, connector).catch(error => { if (!socketAbsent(error) && (error as NodeJS.ErrnoException).code !== "EPIPE") console.error("Runner generation drain failed:", error); }));
    controls.clear();
    void Promise.allSettled(drains).then(() => { for (const target of targets) target.close(); });
  } };
}
