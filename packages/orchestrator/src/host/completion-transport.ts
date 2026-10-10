import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

export interface CompletionHostBoundary { ledgerPath: string; authPath: string; agentDir: string }
export interface CompletionHostStatus { ok: true; boundary: CompletionHostBoundary; runIds: string[] }
export type CompletionHostCommand = { type: "status" } | { type: "start"; runId: string } | { type: "close" };
const run = promisify(execFile);
export function completionHostSocket(ledgerPath: string, uid = process.getuid!()): string {
  if (ledgerPath === ":memory:") throw new Error("Durable completions require a persistent ledger");
  const id = createHash("sha256").update(resolve(ledgerPath)).digest("hex").slice(0, 24);
  return join(`/run/user/${uid}/pi/completions`, `${id}.sock`);
}
export function completionHostEntry(moduleUrl = import.meta.url): string {
  return fileURLToPath(new URL(moduleUrl.endsWith(".ts") ? "../../dist/host/completion-host.js" : "./completion-host.js", moduleUrl));
}
export function completionHostRequest(socketPath: string, command: CompletionHostCommand, signal?: AbortSignal): Promise<CompletionHostStatus> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let input = "", settled = false;
    const finish = (error?: Error, status?: CompletionHostStatus) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve(status!);
    };
    const timer = setTimeout(() => finish(new Error("Completion host acknowledgement uncertain (timeout)")), 5_000);
    const abort = () => finish(new Error("Completion controller observation detached"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    socket.on("connect", () => socket.write(`${JSON.stringify(command)}\n`));
    socket.on("data", chunk => {
      input += chunk.toString();
      if (input.length > 1024 * 1024) { finish(new Error("Completion host response exceeds boundary")); return; }
      const end = input.indexOf("\n"); if (end < 0) return;
      try {
        const value = JSON.parse(input.slice(0, end));
        if (value.ok === false && typeof value.error === "string") { finish(new Error(value.error)); return; }
        if (value.ok !== true || !Array.isArray(value.runIds) || !value.runIds.every((id: unknown) => typeof id === "string") ||
          typeof value.boundary?.ledgerPath !== "string" || typeof value.boundary?.authPath !== "string" || typeof value.boundary?.agentDir !== "string") throw new Error("Invalid completion host acknowledgement");
        finish(undefined, value);
      } catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
    });
    socket.on("error", error => finish(error));
    socket.on("close", () => finish(new Error("Completion host acknowledgement uncertain (closed)")));
  });
}
export function completionHostAbsent(cause: unknown): boolean {
  return ["ENOENT", "ECONNREFUSED"].includes((cause as NodeJS.ErrnoException)?.code ?? "");
}
export async function launchCompletionHost(boundary: CompletionHostBoundary, socketPath: string): Promise<void> {
  const entry = completionHostEntry();
  if (!existsSync(entry)) throw new Error(`Compiled completion host is missing: ${entry}`);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  const runtimeDir = `/run/user/${process.getuid!()}`;
  const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` };
  // The unit receives values from the launcher environment, never credential
  // values in argv. Thread capabilities are not host capabilities.
  for (const key of Object.keys(env)) if (/^(PI_THREAD_|PI_REMOTE_SESSION_ID$|PI_SESSION_FILE$|PI_ORCHESTRATOR_RUN_ID$|PI_ORCHESTRATOR_ACCOUNT_ID$)/.test(key)) delete env[key as keyof typeof env];
  const unit = `pi-completion-${randomBytes(12).toString("hex")}.service`;
  await run("systemd-run", ["--user", "--collect", "--quiet", "--service-type=exec", `--unit=${unit}`,
    "--property=KillMode=control-group", "--property=Restart=no", "--property=OOMPolicy=stop",
    "--property=MemoryMax=4G", "--property=MemorySwapMax=256M", "--property=UMask=0077",
    `--working-directory=${process.cwd()}`,
    ...Object.keys(env).filter(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && env[key as keyof typeof env] !== undefined).map(key => `--setenv=${key}`),
    "/usr/bin/flock", "--no-fork", "--nonblock", "--conflict-exit-code", "75", `${socketPath}.lock`,
    process.execPath, "--max-old-space-size=3072", entry, socketPath, boundary.ledgerPath, boundary.authPath, boundary.agentDir],
    { env, timeout: 5_000, maxBuffer: 64 * 1024 });
}
export interface CompletionHostCustody { uid: number; gid: number; home: string }
/** A shared core observes the original UID-bound socket. A missing host is
 * launched under that same UID/GID, without inheriting the core's private env. */
export async function launchCompletionHostForCustody(boundary: CompletionHostBoundary, socketPath: string, custody: CompletionHostCustody): Promise<void> {
  if (!Number.isSafeInteger(custody.uid) || custody.uid < 0 || !Number.isSafeInteger(custody.gid) || custody.gid < 0 || !custody.home.startsWith("/") || custody.home.includes("\0")) throw new Error("Completion host requires explicit valid UID/GID/home custody");
  if (process.getuid!() !== 0 && (process.getuid!() !== custody.uid || process.getgid!() !== custody.gid)) throw new Error("Completion host custody differs from this controller's actual launch authority");
  const transport = new URL("./completion-transport.js", pathToFileURL(completionHostEntry())).href;
  const source = `import { launchCompletionHost } from ${JSON.stringify(transport)}; await launchCompletionHost(JSON.parse(process.argv[1]), process.argv[2]);`;
  const command = [process.execPath, "--input-type=module", "-e", source, JSON.stringify(boundary), socketPath];
  if (process.getuid!() === 0) command.unshift("/usr/bin/setpriv", "--reuid", String(custody.uid), "--regid", String(custody.gid), "--init-groups", "--");
  await run(command[0]!, command.slice(1), { cwd: custody.home, env: { HOME: custody.home, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", XDG_RUNTIME_DIR: `/run/user/${custody.uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${custody.uid}/bus` }, timeout: 10_000, maxBuffer: 64 * 1024 });
}

export async function ensureCompletionHost(boundary: CompletionHostBoundary, socketPath: string,
  launch = launchCompletionHost, signal?: AbortSignal): Promise<CompletionHostStatus> {
  const status = async () => {
    const value = await completionHostRequest(socketPath, { type: "status" }, signal);
    if (value.boundary.ledgerPath !== boundary.ledgerPath || value.boundary.authPath !== boundary.authPath || value.boundary.agentDir !== boundary.agentDir)
      throw new Error("Live completion host has a different authentication or receipt boundary; wait for its accepted requests to settle");
    return value;
  };
  try { return await status(); } catch (cause) { if (!completionHostAbsent(cause)) throw cause; }
  await launch(boundary, socketPath);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { return await status(); } catch (cause) { if (!completionHostAbsent(cause)) throw cause; }
    await delay(25, undefined, { signal });
  }
  throw new Error("Completion host launch accepted but ownership acknowledgement is uncertain");
}
