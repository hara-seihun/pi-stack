import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { constants as osConstants } from "node:os";
import {
  createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, defineTool, truncateTail,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { startSandboxEgress } from "./pi-sandbox-egress.js";
import { sandboxBashWorker, sandboxFileWorker } from "./pi-sandbox-worker.js";

export const SANDBOX_WORKSPACE = "/workspace";
export interface SandboxRuntime {
  bubblewrap: string;
  shell: string;
  node: string;
  path: string[];
  mounts: { source: string; destination: string }[];
  storePaths?: string[];
}

const storeRoot = /^\/nix\/store\/[a-z0-9]{32}-[^/]+$/;
const runtimePath = /^(?:\/usr(?:\/|$)|\/lib(?:64)?(?:\/|$)|\/bin(?:\/|$)|\/nix\/store\/[a-z0-9]{32}-[^/]+(?:\/|$))/;
const publicSupportPaths = new Set(["/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/cert.pem", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/alternatives/awk", "/etc/alternatives/nawk"]);
const nodeDistributionPath = /^\/opt\/node-v\d+\.\d+\.\d+-linux-(?:x64|arm64)(?:\/|$)/;
function cleanAbsolute(path: unknown): path is string {
  return typeof path === "string" && isAbsolute(path) && path === normalize(path) && !path.includes("\0");
}
function allowedRuntimePath(path: string): boolean {
  return runtimePath.test(path) || nodeDistributionPath.test(path) || publicSupportPaths.has(path);
}

async function loadRuntime(): Promise<SandboxRuntime> {
  const configPath = process.env.PI_SANDBOX_RUNTIME_CONFIG ?? "/etc/pi-stack/sandbox-runtime.json";
  const value: SandboxRuntime = JSON.parse(await readFile(configPath, "utf8"));
  if (!cleanAbsolute(value.bubblewrap) || !cleanAbsolute(value.shell) || !cleanAbsolute(value.node)
    || !Array.isArray(value.path) || !value.path.length || !value.path.every(cleanAbsolute)
    || !Array.isArray(value.mounts) || (value.storePaths !== undefined && !Array.isArray(value.storePaths))) {
    throw new Error(`Invalid sandbox runtime manifest: ${configPath}`);
  }
  for (const root of value.storePaths ?? []) {
    if (!cleanAbsolute(root) || !storeRoot.test(root) || await realpath(root) !== root) {
      throw new Error(`Sandbox store mount must be an explicit derivation directory: ${root}`);
    }
  }
  for (const mount of value.mounts) {
    if (!cleanAbsolute(mount.source) || !cleanAbsolute(mount.destination)
      || !allowedRuntimePath(mount.source) || !allowedRuntimePath(mount.destination)
      || !allowedRuntimePath(await realpath(mount.source))) {
      throw new Error("Sandbox runtime mounts must contain only public system runtime paths");
    }
  }
  const destinations = [...(value.storePaths ?? []), ...value.mounts.map(mount => mount.destination)];
  for (const executable of [value.shell, value.node]) {
    if (!destinations.some(root => executable === root || executable.startsWith(`${root}/`))) {
      throw new Error(`Sandbox executable is not supplied by the runtime mounts: ${executable}`);
    }
  }
  await access(value.bubblewrap);
  return value;
}

function sandboxArguments(runtime: SandboxRuntime, workspace: string, proxySocket?: string): string[] {
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv", "--hostname", "pi-sandbox"];
  for (const root of runtime.storePaths ?? []) args.push("--ro-bind", root, root);
  for (const mount of runtime.mounts) args.push("--ro-bind", mount.source, mount.destination);
  args.push("--bind", workspace, SANDBOX_WORKSPACE, "--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev", "--dir", "/run");
  if (proxySocket) args.push("--ro-bind", proxySocket, "/run/package-proxy.sock");
  if (!runtime.mounts.some(mount => mount.destination === "/bin" || mount.destination === "/bin/sh")) {
    args.push("--dir", "/bin", "--symlink", runtime.shell, "/bin/sh");
  }
  const environment: Record<string, string> = {
    HOME: SANDBOX_WORKSPACE, TMPDIR: "/tmp", LANG: "C.UTF-8", USER: "sandbox", LOGNAME: "sandbox",
    PATH: ["/workspace/.local/bin", "/workspace/node_modules/.bin", ...runtime.path].join(":"),
    SHELL: runtime.shell, PWD: SANDBOX_WORKSPACE,
    NPM_CONFIG_PREFIX: "/workspace/.local", NPM_CONFIG_CACHE: "/workspace/.cache/npm",
    PYTHONUSERBASE: "/workspace/.local", PIP_CACHE_DIR: "/workspace/.cache/pip", PIP_BREAK_SYSTEM_PACKAGES: "1",
    XDG_CONFIG_HOME: "/workspace/.config", XDG_CACHE_HOME: "/workspace/.cache", XDG_DATA_HOME: "/workspace/.local/share",
    SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt", CURL_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt", REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
    GIT_CONFIG_NOSYSTEM: "1", NO_PROXY: "", no_proxy: "",
  };
  if (proxySocket) {
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) environment[name] = "http://127.0.0.1:3128";
  }
  for (const [key, value] of Object.entries(environment)) args.push("--setenv", key, value);
  args.push("--chdir", SANDBOX_WORKSPACE, "--remount-ro", "/", "--");
  return args;
}

interface RunResult { stdout: Buffer; stderr: Buffer; exitCode: number; }
async function runSandbox(runtime: SandboxRuntime, workspace: string, command: string[], options: {
  input?: string; signal?: AbortSignal; timeoutSeconds?: number; proxySocket?: string;
} = {}): Promise<RunResult> {
  options.signal?.throwIfAborted();
  const timeoutSeconds = Math.min(1800, Math.max(0.01, options.timeoutSeconds ?? 15));
  if (!Number.isFinite(timeoutSeconds)) throw new Error("Sandbox timeout must be finite");
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.bubblewrap, [...sandboxArguments(runtime, workspace, options.proxySocket), ...command], {
      env: {}, cwd: "/", stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let failure: Error | undefined;
    const terminate = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const abort = () => terminate(new Error("aborted"));
    const timer = setTimeout(() => terminate(new Error(`timeout:${timeoutSeconds}`)), timeoutSeconds * 1000);
    options.signal?.addEventListener("abort", abort, { once: true });
    // File reads need complete buffers; stderr is only a diagnostic and is capped.
    let stderrBytes = 0;
    child.stdout.on("data", (data: Buffer) => stdout.push(data));
    child.stderr.on("data", (data: Buffer) => { if (stderrBytes < 32_768) stderr.push(data.subarray(0, 32_768 - stderrBytes)); stderrBytes += data.length; });
    child.once("error", error => { failure ??= error; });
    child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") terminate(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code ?? 128 + (signal ? osConstants.signals[signal] ?? 1 : 1) });
    });
    child.stdin.end(options.input ?? "");
    if (options.signal?.aborted) abort();
  });
}

/** Only the workspace and explicitly selected public runtime are mounted. No host execution fallback. */
export async function createSandboxTools(workspace: string): Promise<ToolDefinition[]> {
  const root = await realpath(workspace);
  if (!(await stat(root)).isDirectory() || root === "/") throw new Error("Sandbox workspace must be a dedicated directory");
  if (process.platform !== "linux") throw new Error("Sandbox tools require Linux namespace isolation");
  const runtime = await loadRuntime();
  const probe = await runSandbox(runtime, root, [runtime.node, "--eval", "require('node:child_process').execFileSync(process.argv[1],['--noprofile','--norc','-c','true']);process.stdout.write('sandbox-ready')", runtime.shell]);
  if (probe.exitCode !== 0 || probe.stdout.toString() !== "sandbox-ready") {
    throw new Error(`Sandbox isolation/runtime probe failed: ${probe.stderr.toString()}`);
  }
  const signals = new AsyncLocalStorage<AbortSignal | undefined>();
  async function fileOperation(operation: string, path: string, content?: string, write?: boolean): Promise<Buffer> {
    const response = await runSandbox(runtime, root, [runtime.node, "--eval", sandboxFileWorker], {
      input: JSON.stringify({ operation, path, content, write }), signal: signals.getStore(),
    });
    if (response.exitCode !== 0) throw new Error(response.stderr.toString() || `Sandbox ${operation} failed`);
    return response.stdout;
  }
  const readOperations = {
    readFile: (path: string) => fileOperation("read", path),
    access: async (path: string) => { await fileOperation("access", path); },
    detectImageMimeType: async (path: string) => (await fileOperation("mime", path)).toString() || null,
  };
  const writeFile = async (path: string, content: string) => { await fileOperation("write", path, content); };
  const tools: ToolDefinition[] = [
    defineTool(createReadToolDefinition(SANDBOX_WORKSPACE, { operations: readOperations, autoResizeImages: false })),
    defineTool(createWriteToolDefinition(SANDBOX_WORKSPACE, { operations: { writeFile, mkdir: async path => { await fileOperation("mkdir", path); } } })),
    defineTool(createEditToolDefinition(SANDBOX_WORKSPACE, { operations: { readFile: readOperations.readFile, writeFile, access: async path => { await fileOperation("access", path, undefined, true); } } })),
    defineTool(createBashToolDefinition(SANDBOX_WORKSPACE, {
      exposeSessionEnvironment: false,
      operations: { exec: async (command, _cwd, options) => {
        const egress = await startSandboxEgress();
        if (!egress.ok) throw new Error(`Sandbox public egress unavailable: ${egress.error.message}`);
        try {
          const response = await runSandbox(runtime, root, [runtime.node, "--eval", sandboxBashWorker], {
            input: JSON.stringify({ shell: runtime.shell, command }), signal: options.signal,
            timeoutSeconds: options.timeout ?? 55, proxySocket: egress.value.socketPath,
          });
          // Workers cap the UTF-8 text beneath the upstream accumulator's spill thresholds.
          options.onData(Buffer.from(truncateTail(Buffer.concat([response.stdout, response.stderr]).toString("utf8"), { maxBytes: 45_000, maxLines: 1700 }).content));
          return { exitCode: response.exitCode };
        } finally { await egress.value.close(); }
      } },
    })),
  ];
  return tools.map(tool => ({
    ...tool,
    description: tool.description + (tool.name === "bash"
      ? " Sandbox cwd and home: /workspace. Only this workspace is persistent and writable; /tmp is private temporary storage. Runtime files are read-only. Install npm packages locally or use npm install -g (prefix /workspace/.local); Python: python3 -m venv .venv or pip install --user (user base /workspace/.local). Public HTTP/HTTPS downloads use HTTP_PROXY/HTTPS_PROXY through a bounded proxy; localhost, LAN, tailnet, host addresses and direct networking are unavailable. No host credentials or environment are inherited. Commands default to a 55-second timeout; an explicit timeout may extend to 1800 seconds. Large output is saved under /workspace/.pi-output-*.log."
      : " Paths are relative to /workspace; absolute paths and symlinks must stay inside /workspace. ~/ refers to /workspace."),
    execute: (id, input, signal, onUpdate, context) => signals.run(signal, () => tool.execute(id,
      input !== null && typeof input === "object" && "path" in input && typeof input.path === "string" && (input.path === "~" || input.path.startsWith("~/"))
        ? { ...input, path: input.path === "~" ? SANDBOX_WORKSPACE : `${SANDBOX_WORKSPACE}/${input.path.slice(2)}` } : input,
      signal, onUpdate, { ...context, cwd: SANDBOX_WORKSPACE })),
  }));
}
