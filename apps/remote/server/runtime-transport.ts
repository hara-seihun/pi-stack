import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

type RuntimeOutput = (line: string) => void;
type RuntimeExit = (code: number) => void;

export interface RuntimeTransport {
  readonly pid: number;
  readonly socketPath: string;
  send(value: unknown): void;
  terminate(): Promise<void>;
  detach(): void;
  onExit(listener: RuntimeExit): void;
  readonly exited: Promise<number>;
}

type ConnectionResult = { transport: RuntimeTransport } | { error: Error };

function errorValue(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

async function connectHost(socketPath: string, onOutput: RuntimeOutput, timeoutMs = 2_000): Promise<ConnectionResult> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let input = "";
    let attached = false;
    let detached = false;
    let pid = 0;
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
      socketPath,
      send(value) {
        if (!socket.writable || detached) throw new Error("Runtime host is disconnected");
        socket.write(`${JSON.stringify({ type: "command", value })}\n`);
      },
      async terminate() {
        if (socket.writable && !detached) socket.write('{"type":"terminate"}\n');
        await Promise.race([exited, Bun.sleep(2_500)]);
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

export function runtimeSocketPath(data: string, sessionId: string): string {
  return join(data, "runtime-hosts", `${sessionId}.sock`);
}

export async function attachRuntimeHost(socketPath: string, onOutput: RuntimeOutput): Promise<RuntimeTransport> {
  const connected = await connectHost(socketPath, onOutput);
  if ("error" in connected) throw connected.error;
  return connected.transport;
}

export async function startRuntimeHost(options: {
  data: string;
  sessionId: string;
  cwd: string;
  args: string[];
  env: Record<string, string | undefined>;
  onOutput: RuntimeOutput;
}): Promise<RuntimeTransport> {
  const directory = join(options.data, "runtime-hosts");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const socketPath = runtimeSocketPath(options.data, options.sessionId);
  if (existsSync(socketPath)) {
    const existing = await connectHost(socketPath, options.onOutput, 250);
    if (!("error" in existing)) return existing.transport;
    try { unlinkSync(socketPath); } catch {}
  }
  const encodedArgs = Buffer.from(JSON.stringify(options.args)).toString("base64url");
  Bun.spawn([process.execPath, join(import.meta.dir, "runtime-host.ts"), socketPath, options.cwd, encodedArgs], {
    cwd: options.cwd,
    detached: true,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: options.env,
  });
  const deadline = Date.now() + 2_000;
  let lastError = new Error("Runtime host did not start");
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      const connected = await connectHost(socketPath, options.onOutput, 250);
      if (!("error" in connected)) return connected.transport;
      lastError = connected.error;
    }
    await Bun.sleep(25);
  }
  throw lastError;
}
