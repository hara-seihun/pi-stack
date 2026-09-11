import { existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { basename, join } from "node:path";
import { underMemoryPressure } from "./shared-runtime-memory.mjs";

type RuntimeOutput = (line: string) => void;
type RuntimeExit = (code: number) => void;

export interface RuntimeTransport {
  readonly pid: number;
  readonly shared: boolean;
  readonly socketPath: string;
  send(value: unknown): void;
  terminate(): Promise<void>;
  detach(): void;
  onExit(listener: RuntimeExit): void;
  readonly exited: Promise<number>;
}

type ConnectionResult = { transport: RuntimeTransport } | { error: Error };

function duration(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const CONNECT_TIMEOUT_MS = duration("PI_REMOTE_RUNTIME_CONNECT_TIMEOUT_MS", 2_000);
const START_TIMEOUT_MS = duration("PI_REMOTE_RUNTIME_START_TIMEOUT_MS", 2_000);
const TERMINATE_TIMEOUT_MS = duration("PI_REMOTE_RUNTIME_TERMINATE_TIMEOUT_MS", 2_500);
const START_POLL_MS = duration("PI_REMOTE_RUNTIME_START_POLL_MS", 25);

function errorValue(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

async function connectHost(socketPath: string, onOutput: RuntimeOutput, timeoutMs = CONNECT_TIMEOUT_MS): Promise<ConnectionResult> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let input = "";
    let attached = false;
    let detached = false;
    let pid = 0;
    let shared = false;
    let lastSequence = 0;
    let resolveExit!: (code: number) => void;
    let exitCode: number | null = null;
    const exitListeners = new Set<RuntimeExit>();
    const exited = new Promise<number>((done) => { resolveExit = done; });
    const timer = setTimeout(() => finish({ error: new Error(`runtime host connection timed out: ${socketPath}`) }), timeoutMs);

    function finish(result: ConnectionResult) {
      clearTimeout(timer);
      if (!attached && "error" in result) socket.destroy();
      resolve(result);
    }

    const transport: RuntimeTransport = {
      get pid() { return pid; },
      get shared() { return shared; },
      socketPath,
      send(value) {
        if (!socket.writable || detached) throw new Error("Runtime host is disconnected");
        socket.write(`${JSON.stringify({ type: "command", value })}\n`);
      },
      async terminate() {
        if (socket.writable && !detached) socket.write('{"type":"terminate"}\n');
        await Promise.race([exited, Bun.sleep(TERMINATE_TIMEOUT_MS)]);
      },
      detach() {
        detached = true;
        socket.end();
      },
      onExit(listener) {
        if (exitCode !== null) queueMicrotask(() => listener(exitCode!));
        else exitListeners.add(listener);
      },
      exited,
    };

    function handle(value: any) {
      if (value?.type === "output") {
        const sequence = Number(value.sequence ?? 0);
        if (!Number.isSafeInteger(sequence) || sequence <= lastSequence) return;
        onOutput(String(value.line ?? ""));
        lastSequence = sequence;
        if (socket.writable) socket.write(`${JSON.stringify({ type: "ack", sequence })}\n`);
        return;
      }
      if (value?.type === "attached") {
        pid = Number(value.pid ?? 0);
        shared = value.shared === true;
        if (!Number.isSafeInteger(pid) || pid <= 1) return finish({ error: new Error("Runtime host returned an invalid child pid") });
        attached = true;
        finish({ transport });
        return;
      }
      if (value?.type === "exit") {
        const code = Number(value.code ?? 1);
        exitCode = code;
        resolveExit(code);
        for (const listener of exitListeners) listener(code);
        exitListeners.clear();
        return;
      }
      if (value?.type === "host_error") console.error(`[runtime host] ${String(value.error ?? "unknown error")}`);
    }

    socket.setNoDelay(true);
    socket.on("connect", () => socket.write('{"type":"attach","after":0}\n'));
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      while (true) {
        const newline = input.indexOf("\n");
        if (newline < 0) break;
        let line = input.slice(0, newline);
        input = input.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line) continue;
        try { handle(JSON.parse(line)); }
        catch (cause) { console.error("Malformed runtime host message", cause); }
      }
    });
    socket.on("error", (cause) => { if (!attached) finish({ error: errorValue(cause) }); });
    socket.on("close", () => {
      if (!attached) finish({ error: new Error(`Runtime host closed before attach: ${socketPath}`) });
      else if (!detached && exitCode === null) {
        exitCode = 1;
        for (const listener of exitListeners) listener(1);
        exitListeners.clear();
        resolveExit(1);
      }
    });
  });
}

export function runtimeSocketPath(data: string, sessionId: string, runtimeId: string = crypto.randomUUID()): string {
  return join(data, "runtime-hosts", `${sessionId}.${runtimeId}.sock`);
}

export async function attachRuntimeHost(socketPath: string, onOutput: RuntimeOutput): Promise<RuntimeTransport> {
  const connected = await connectHost(socketPath, onOutput);
  if ("error" in connected) throw connected.error;
  return connected.transport;
}

export async function startCommandRuntimeHost(options: {
  data: string;
  sessionId: string;
  priority?: boolean;
  cwd: string;
  args: string[];
  env: Record<string, string | undefined>;
  onOutput: RuntimeOutput;
  signal?: AbortSignal;
}): Promise<RuntimeTransport> {
  const directory = join(options.data, "runtime-hosts");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const socketPath = runtimeSocketPath(options.data, options.sessionId);
  const encodedArgs = Buffer.from(JSON.stringify(options.args)).toString("base64url");
  options.signal?.throwIfAborted();
  const host = Bun.spawn([process.execPath, join(import.meta.dir, "runtime-host.ts"), socketPath, options.cwd, encodedArgs], {
    cwd: options.cwd,
    detached: true,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: options.env,
  });
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError = new Error("Runtime host did not start");
  try {
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      if (existsSync(socketPath)) {
        const connected = await connectHost(socketPath, options.onOutput, Math.min(250, CONNECT_TIMEOUT_MS));
        if (!("error" in connected)) {
          if (options.signal?.aborted) {
            await connected.transport.terminate();
            options.signal.throwIfAborted();
          }
          return connected.transport;
        }
        lastError = connected.error;
      }
      await Bun.sleep(START_POLL_MS);
    }
    throw lastError;
  } catch (cause) {
    host.kill("SIGTERM");
    await host.exited;
    throw cause;
  }
}

type StartOptions = Parameters<typeof startCommandRuntimeHost>[0];
const runnerStarts = new Map<string, Promise<void>>();

function runnerControl(data: string) {
  const generation = createHash("sha256").update(import.meta.dir).digest("hex").slice(0,16);
  return join(data, "runtime-runners", `${generation}.sock`);
}

export async function runtimeCapacity(data: string, priority = false): Promise<number> {
  if (process.env.PI_REMOTE_RUNTIME_DRIVER === "command") return 1;
  if (underMemoryPressure()) return 0;
  const control = runnerControl(data);
  if (!existsSync(control)) return 1;
  try { const status = await runnerRequest(control, {type:"status"}); return Number((priority ? status.availableSlots : status.backgroundSlots) ?? 0); }
  catch (error: any) {
    // Only a refused/missing endpoint permits a launch attempt; flock still
    // arbitrates ownership if a live runner is initializing or shutting down.
    return ["ENOENT", "ECONNREFUSED"].includes(error.code) ? 1 : 0;
  }
}

function runnerRequest(path: string, value: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let input = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Runner capacity busy: control response delayed")); }, duration("PI_REMOTE_RUNNER_CONTROL_TIMEOUT_MS", 5_000));
    socket.on("connect", () => socket.write(JSON.stringify(value) + "\n"));
    socket.on("data", chunk => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      clearTimeout(timer); socket.end();
      try { const response = JSON.parse(input.slice(0, input.indexOf("\n"))); response.error ? reject(new Error(response.error)) : resolve(response); }
      catch (error) { reject(error); }
    });
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("close", () => { clearTimeout(timer); reject(new Error("Shared runner control closed")); });
  });
}

export async function startRuntimeHost(options: StartOptions): Promise<RuntimeTransport> {
  options.signal?.throwIfAborted();
  // Explicit external RPC executables remain useful for transport fixtures.
  // Production Pi always uses the shared SDK host.
  if (options.env.PI_REMOTE_RUNTIME_DRIVER === "command") return startCommandRuntimeHost(options);
  const directory = join(options.data, "runtime-runners");
  mkdirSync(directory, {recursive:true,mode:0o700});
  mkdirSync(join(options.data, "runtime-hosts"), {recursive:true,mode:0o700});
  const control = runnerControl(options.data);
  let starting = runnerStarts.get(control);
  if (!starting) {
    starting = (async () => {
      if (existsSync(control)) {
        try { await runnerRequest(control, {type:"status"}); return; }
        catch (error: any) {
          if (!["ECONNREFUSED", "ENOENT"].includes(error.code)) throw new Error(`Runner capacity busy: ${error.message}`);
        }
      }
      const env = {...options.env};
      for (const key of Object.keys(env)) if (/^(PI_REMOTE_SESSION_ID|PI_REMOTE_CONTEXT_OWNER_PID|PI_SUBAGENT_MODEL|PI_REMOTE_MEETING_ID|PI_REMOTE_SERVICE_TIER_FILE)$/.test(key)) delete env[key];
      // The kernel holds this lease for the Node process's lifetime. Only its
      // owner may remove a stale socket. A timeout cannot create a second host.
      const host = Bun.spawn(["flock", "--no-fork", "--nonblock", "--conflict-exit-code", "75", `${control}.lock`,
        "node", "--max-old-space-size=8192", join(import.meta.dir,"shared-runtime-host.mjs"), control], {
        cwd: options.env.HOME, detached:true, stdin:"ignore", stdout:"inherit", stderr:"inherit", env,
      });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (host.exitCode !== null) throw new Error(host.exitCode === 75 ? "Runner capacity busy: owner is initializing or stopping" : `Shared runner exited ${host.exitCode}`);
        if (existsSync(control)) { try { await runnerRequest(control,{type:"status"}); return; } catch {} }
        await Bun.sleep(50);
      }
      host.kill("SIGTERM"); throw new Error("Shared runner did not start");
    })().finally(() => runnerStarts.delete(control));
    runnerStarts.set(control, starting);
  }
  await starting;
  options.signal?.throwIfAborted();
  // Linux sockaddr_un allows 107 pathname bytes. Full thread + launch UUIDs
  // exceed that under a real person's encrypted data directory in Node.
  const generation = basename(control, ".sock");
  const socketPath = join(options.data, "runtime-hosts", `${generation}.${createHash("sha256").update(options.sessionId).digest("hex").slice(0, 20)}.sock`);
  try {
    await runnerRequest(control, {type:"open",options:{socketPath,sessionId:options.sessionId,priority:options.priority,cwd:options.cwd,args:options.args,env:options.env}});
  } catch (error: any) {
    // A timed-out open may already own a live session. Retrying the same socket
    // rejoins it rather than creating an unclaimed sibling.
    if (error.message === "Shared runner control timed out") throw new Error(`Runner capacity busy: ${error.message}`);
    throw error;
  }
  const connected = await connectHost(socketPath, options.onOutput, CONNECT_TIMEOUT_MS);
  if ("error" in connected) {
    await runnerRequest(control, {type:"close",socketPath}).catch(() => {});
    throw connected.error;
  }
  if (options.signal?.aborted) { await connected.transport.terminate(); options.signal.throwIfAborted(); }
  return connected.transport;
}
