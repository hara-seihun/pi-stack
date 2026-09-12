import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type Json = Record<string, unknown>;
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: string };
export interface CodexRpc {
  request<T = Json>(method: string, params: Json): Promise<RpcResult<T>>;
  notify(method: string, params?: Json): void;
  close(): Promise<void>;
}
export interface CodexRpcOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  binary?: string;
  args?: string[];
  sanitizeError?(message: string): string;
  notification(method: string, params: Json): void;
  serverRequest(method: string, params: Json): Promise<RpcResult<unknown>>;
  exit(code?: number): void;
}
export type OpenCodexRpc = (options: CodexRpcOptions) => CodexRpc;

export const openCodexRpc: OpenCodexRpc = options => {
  const child = spawn(options.binary ?? "codex", ["app-server", "--listen", "stdio://", ...(options.args ?? [])], {
    cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"],
  });
  // Native diagnostics can contain request bodies. They never enter portable logs.
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let nextId = 0, stopped = false, closing = false;
  let closePromise: Promise<void> | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
  };
  const pending = new Map<number, { method: string; resolve(value: RpcResult<unknown>): void; timer: NodeJS.Timeout }>();
  const write = (value: unknown) => {
    if (!stopped) child.stdin.write(JSON.stringify(value) + "\n");
  };
  const finish = (code?: number) => {
    if (stopped) return;
    stopped = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.resolve({ ok: false, error: `Codex app-server exited during ${item.method}; outcome unknown` });
    }
    pending.clear();
    lines.close();
    options.exit(code);
  };
  child.once("error", () => finish(1));
  child.stdin.on("error", () => { terminate(); finish(1); });
  child.once("exit", code => { clearTimeout(killTimer); finish(code ?? undefined); });
  lines.on("line", line => {
    let message: Json;
    try { message = JSON.parse(line); }
    catch { terminate(); finish(1); return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) { terminate(); finish(1); return; }
    if (typeof message.method === "string") {
      const params = message.params && typeof message.params === "object" ? message.params as Json : {};
      if (message.id !== undefined) {
        const id = message.id;
        void options.serverRequest(message.method, params).then(result => {
          write(result.ok ? { id, result: result.value } : { id, error: { code: -32000, message: result.error } });
        }, () => write({ id, error: { code: -32000, message: "Codex client request failed" } }));
      } else options.notification(message.method, params);
      return;
    }
    const item = pending.get(message.id as number);
    if (!item) return;
    pending.delete(message.id as number);
    clearTimeout(item.timer);
    // Auth failures remain opaque. Other error messages pass through the credential guard.
    const error = message.error as { message?: unknown } | undefined;
    const detail = !item.method.startsWith("account/") && typeof error?.message === "string"
      ? options.sanitizeError?.(error.message) : undefined;
    item.resolve(error ? { ok: false, error: `Codex rejected ${item.method}${detail ? `: ${detail}` : ""}` } : { ok: true, value: message.result });
  });
  return {
    request<T>(method: string, params: Json): Promise<RpcResult<T>> {
      if (stopped || closing) return Promise.resolve({ ok: false, error: "Codex app-server is closed" });
      const id = ++nextId;
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: `Codex ${method} timed out; outcome unknown` });
          terminate();
          finish(1);
        }, 30_000);
        pending.set(id, { method, resolve: resolve as (value: RpcResult<unknown>) => void, timer });
        write({ id, method, params });
      });
    },
    notify: (method, params) => write({ method, params }),
    close() {
      return closePromise ??= new Promise<void>(resolve => {
        closing = true;
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        child.once("exit", () => resolve());
        child.stdin.end();
        terminate();
      });
    },
  };
};
