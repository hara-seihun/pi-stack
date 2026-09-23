import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { AttachPiSession, OpenPiSession, PiCommand, PiEvent, PiRunnerReference, PiSession, PiSessionOptions } from "./contracts.js";
import { underMemoryPressure } from "./runner-memory.js";
import { isolatePiEnvironment } from "./pi-environment.js";

interface Connection { send(command: PiCommand): void; detach(): void }
const starts = new Map<string, Promise<void>>();
function socketAbsent(error: unknown): boolean {
  const failure = error as NodeJS.ErrnoException;
  return failure?.syscall === "connect" && ["ENOENT", "ECONNREFUSED"].includes(failure.code ?? "");
}
function runnerRequest(path: string, value: unknown, timeout = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let input = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Thread runner control timed out")); }, timeout);
    socket.on("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on("data", chunk => {
      input += chunk.toString();
      const end = input.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer); socket.end();
      try { const response = JSON.parse(input.slice(0, end)); response.error ? reject(new Error(response.error)) : resolve(response); }
      catch (error) { reject(error); }
    });
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("close", () => { clearTimeout(timer); reject(new Error("Thread runner control closed")); });
  });
}
function connect(path: string, output: (event: PiEvent) => void, exit: (code: number) => void): Promise<Connection> {
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
      detach() { detached = true; clearTimeout(retry); socket.destroy(); unsent.length = 0; },
    };
    function finish(code = 1) { if (!ended) { ended = true; clearTimeout(retry); exit(code); } }
    function open() {
      if (detached || ended) return;
      const current = socket = createConnection(path);
      let input = "";
      const decoder = new StringDecoder("utf8");
      connected = false;
      const timer = setTimeout(() => current.destroy(new Error("Thread runner attach timed out")), 5000);
      current.setNoDelay(true);
      current.on("connect", () => current.write(`${JSON.stringify({ type: "attach", after: sequence })}\n`));
      current.on("data", chunk => {
        if (current !== socket) return;
        input += decoder.write(chunk);
        let end: number;
        while ((end = input.indexOf("\n")) >= 0) {
          const line = input.slice(0, end); input = input.slice(end + 1);
          if (!line) continue;
          try {
            const value = JSON.parse(line);
            if (value.type === "attached") {
              attached = true; connected = true; clearTimeout(timer);
              for (const line of unsent.splice(0)) current.write(line);
              resolve(connection);
            } else if (value.type === "output") {
              const next = Number(value.sequence);
              if (!Number.isSafeInteger(next) || next <= sequence) continue;
              output(JSON.parse(value.line));
              sequence = next;
              current.write(`${JSON.stringify({ type: "ack", sequence })}\n`);
            } else if (value.type === "exit") finish(Number(value.code));
          } catch (error) { current.destroy(error instanceof Error ? error : new Error(String(error))); }
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
function boundary(options: PiSessionOptions) {
  const isolation = options.args.includes("--orchestrator-context") ? `isolated:${options.cwd}` : "normal";
  return hash(JSON.stringify([import.meta.url, process.getuid?.(), options.env.HOME ?? process.env.HOME, options.env.PI_CODING_AGENT_DIR ?? "", options.env.PI_ORCHESTRATOR_EXECUTION ?? "user", options.env.PI_MODEL_BROKER_URL ?? "direct", isolation]));
}
async function ensureRunner(control: string, options: PiSessionOptions, durable: boolean): Promise<void> {
  if (existsSync(control)) {
    try { await runnerRequest(control, { type: "status" }); return; }
    catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  if (underMemoryPressure()) throw new Error("Runner capacity busy: memory pressure");
  const env = { ...process.env, ...options.env };
  const broker = !!options.env.PI_MODEL_BROKER_URL;
  const brokerSecrets = ["PI_ORCHESTRATOR_AUTH", "PI_ORCHESTRATOR_OWNER_UID", "PI_ORCHESTRATOR_OWNER_GID", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
  if (broker) for (const key of brokerSecrets) delete env[key];
  if (options.args.includes("--orchestrator-context")) {
    isolatePiEnvironment(options.cwd, env);
    mkdirSync(env.HOME!, { recursive: true, mode: 0o700 });
  }
  for (const key of Object.keys(env)) if (/^(PI_REMOTE_SESSION_ID|PI_THREAD_ID|PI_THREAD_REQUIRE_SESSION|PI_THREAD_CAN_SPAWN|PI_REMOTE_CONTEXT_OWNER_PID|PI_SUBAGENT_MODEL|PI_REMOTE_MEETING_ID|PI_REMOTE_SERVICE_TIER_FILE|PI_ORCHESTRATOR_RUN_ID|PI_SESSION_FILE)$/.test(key)) delete env[key];
  const entry = runnerHostEntry();
  if (!existsSync(entry)) throw new Error(`Compiled thread runner is missing: ${entry}; build pi-orchestrator before starting threads`);
  const root = options.env.PI_ORCHESTRATOR_EXECUTION === "root-repair";
  if (root && broker) throw new Error("Root repair cannot use a model-broker execution boundary");
  if (root && (!durable || options.args.includes("--orchestrator-context"))) throw new Error("Root repair requires the fleet execution boundary without isolated context");
  if (root) { env.PI_ORCHESTRATOR_OWNER_UID = String(process.getuid!()); env.PI_ORCHESTRATOR_OWNER_GID = String(process.getgid!()); }
  const command = [executable("flock", env.PATH), "--no-fork", "--nonblock", "--conflict-exit-code", "75", `${control}.lock`, executable("node", env.PATH), "--max-old-space-size=8192", entry, control];
  if (durable) {
    if (!root) Object.assign(env, userManagerEnvironment(process.getuid!()));
    const validKey = (key: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
    const unset = [...new Set([...Object.keys(process.env).filter(key => validKey(key) && !(key in env)), ...(broker ? brokerSecrets : [])])];
    command.unshift("systemd-run", ...(root ? [] : ["--user"]), "--collect", "--quiet", "--wait", "--service-type=exec",
      "--property=KillMode=control-group", `--working-directory=${env.HOME}`,
      ...Object.keys(env).filter(key => validKey(key) && env[key] !== undefined).map(key => `--setenv=${key}`),
      ...(unset.length ? [`--property=UnsetEnvironment=${unset.join(" ")}`] : []),
      `--unit=pi-thread-runner-${hash(control)}`);
  }
  if (root) command.unshift("sudo", "-n", "--preserve-env");
  const host = spawn(command[0]!, command.slice(1), {
    cwd: env.HOME, detached: true, stdio: ["ignore", "inherit", "inherit"], env,
  });
  host.unref();
  let launchError: Error | undefined;
  host.on("error", error => { launchError = error; });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (host.exitCode !== null && host.exitCode !== 75) throw new Error(`Thread runner exited ${host.exitCode}`);
    if (existsSync(control)) {
      try { await runnerRequest(control, { type: "status" }); return; }
      catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
    await delay(25);
  }
  throw new Error("Thread runner startup has not acknowledged ownership");
}

export function runnerSocketDirectory(dataDir: string, uid = process.getuid!()): string {
  const absolute = resolve(dataDir);
  const longest = join(absolute, "thread-sockets", `${"0".repeat(16)}.${"0".repeat(16)}.sock`);
  // Managed OIDC homes exceed Linux's 107-byte pathname limit for Unix sockets.
  return Buffer.byteLength(longest) <= 107 ? absolute : `/run/user/${uid}/pi/${hash(absolute)}`;
}

export function createSharedPiSessionOpener({ dataDir, durable = false }: { dataDir: string; durable?: boolean }): { openSession: OpenPiSession; attachSession: AttachPiSession; detach(): void } {
  const socketDir = runnerSocketDirectory(dataDir);
  const connections = new Set<Connection>();
  function validate(reference: PiRunnerReference): PiRunnerReference {
    if (!reference || typeof reference.control !== "string" || typeof reference.socketPath !== "string") throw new Error("Invalid recorded runner reference");
    const control = resolve(reference.control), socketPath = resolve(reference.socketPath);
    if (dirname(control) !== join(socketDir, "thread-runners") || dirname(socketPath) !== join(socketDir, "thread-sockets")) throw new Error("Recorded runner is outside this execution boundary");
    return { control, socketPath };
  }
  async function attach({ control, socketPath }: PiRunnerReference, output: (event: PiEvent) => void, exit: (code: number) => void): Promise<PiSession> {
    let connection: Connection | undefined;
    connection = await connect(socketPath, output, code => { if (connection) connections.delete(connection); exit(code); });
    const attached = connection;
    connections.add(attached);
    try { output({ type: "runner_attached", control, socketPath }); }
    catch (error) { attached.detach(); connections.delete(attached); throw error; }
    return {
      command: async command => { attached.send(command); },
      close: async () => {
        await runnerRequest(control, { type: "close", socketPath }, 35_000);
        attached.detach(); connections.delete(attached);
      },
    };
  }
  const attachSession: AttachPiSession = async (reference, output, exit) => {
    if (reference === undefined) return null;
    const recorded = validate(reference);
    try {
      const status = await runnerRequest(recorded.control, { type: "status" });
      if (status?.ok !== true) throw new Error("Thread runner did not acknowledge status");
      return await attach(recorded, output, exit);
    } catch (error) { if (socketAbsent(error)) return null; throw error; }
  };
  const openSession: OpenPiSession = async (options, output, exit) => {
    const retained = options.env.PI_THREAD_RUNNER_REFERENCE ? validate(JSON.parse(options.env.PI_THREAD_RUNNER_REFERENCE)) : undefined;
    const group = boundary(options);
    const control = retained?.control ?? join(socketDir, "thread-runners", `${group}.sock`);
    const socketPath = retained?.socketPath ?? join(socketDir, "thread-sockets", `${group}.${hash(options.threadId)}.sock`);
    const reference = validate({ control, socketPath });
    mkdirSync(dirname(control), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
    let starting = starts.get(control);
    if (!starting) {
      starting = ensureRunner(control, options, durable).finally(() => starts.delete(control));
      starts.set(control, starting);
    }
    await starting;
    const { threads: _threads, ...serializable } = options;
    if (!options.env.PI_THREAD_API_URL) throw new Error("Shared Pi sessions require their owning PI_THREAD_API_URL");
    await runnerRequest(control, { type: "open", options: { ...serializable, socketPath, priority: options.env.PI_THREAD_ADMISSION !== "background" } });
    return attach(reference, output, exit);
  };
  return { openSession, attachSession, detach() { for (const connection of connections) connection.detach(); connections.clear(); } };
}
