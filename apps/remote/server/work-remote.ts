import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  truncateHead,
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { processGroupCleanupCommand } from "./remote-process";

const SSH = process.env.PI_REMOTE_WORK_SSH || "";
const REMOTE_HOME = process.env.PI_REMOTE_WORK_HOME || "/Users/liminal";
const REMOTE_CWD = process.env.PI_REMOTE_WORK_CWD || `${REMOTE_HOME}/sara/converge`;
const TARGET_ID = process.env.PI_REMOTE_EXECUTION_TARGET || "work";
const MACHINE_NAME = process.env.PI_REMOTE_WORK_NAME || "Remote host";
const LOCAL_CWD = process.cwd();
const LOCAL_HOME = homedir();
const stagedByCall = new Map<string, string>();

// Pi-core-owned assets (the agent directory, configured skills) live on the
// local core host, not the work machine. The system prompt references them by
// local path, so filesystem reads of these prefixes must stay local instead of
// being remapped over SSH.
function coreAssetPrefixes(): string[] {
  const prefixes = [join(LOCAL_HOME, ".pi")];
  try {
    const settings = JSON.parse(readFileSync(join(LOCAL_HOME, ".pi/agent/settings.json"), "utf8")) as {
      skills?: unknown;
    };
    for (const skill of Array.isArray(settings.skills) ? settings.skills : []) {
      if (typeof skill === "string" && skill.startsWith("/")) prefixes.push(skill);
    }
  } catch {}
  return prefixes;
}

const CORE_ASSET_PREFIXES = coreAssetPrefixes();

function isCoreAssetPath(path: unknown): boolean {
  if (typeof path !== "string" || !path) return false;
  const value = path === "~" || path.startsWith("~/") ? join(LOCAL_HOME, path.slice(2)) : path;
  if (!value.startsWith("/")) return false;
  return CORE_ASSET_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function toRemote(path: string): string {
  if (path === LOCAL_CWD) return REMOTE_CWD;
  if (path.startsWith(`${LOCAL_CWD}/`)) return REMOTE_CWD + path.slice(LOCAL_CWD.length);
  if (path === LOCAL_HOME) return REMOTE_HOME;
  if (path.startsWith(`${LOCAL_HOME}/`)) return REMOTE_HOME + path.slice(LOCAL_HOME.length);
  return path;
}

function remoteInputPath(path: unknown): string {
  const value = String(path || ".");
  if (value === "~") return REMOTE_HOME;
  if (value.startsWith("~/")) return join(REMOTE_HOME, value.slice(2));
  if (value.startsWith("/")) return toRemote(value);
  return join(REMOTE_CWD, value);
}

type SshResult = { stdout: Buffer; stderr: Buffer; exitCode: number | null };

function sshRun(command: string, options: {
  input?: Buffer | string;
  signal?: AbortSignal;
  timeoutSeconds?: number;
  onData?: (data: Buffer) => void;
  token?: string;
} = {}): Promise<SshResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error("aborted"));
    const child = spawn("ssh", [SSH, command], { stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const stopRemote = () => {
      if (!options.token) return;
      const file = `${REMOTE_HOME}/.cache/pi-remote/processes/${options.token}.pid`;
      const killer = spawn("ssh", [SSH, processGroupCleanupCommand(file)], { stdio: "ignore" });
      killer.unref();
    };
    const stop = () => {
      stopRemote();
      try { child.kill("SIGTERM"); } catch {}
    };
    const onAbort = () => stop();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = options.timeoutSeconds
      ? setTimeout(() => { timedOut = true; stop(); }, options.timeoutSeconds * 1000)
      : undefined;

    child.stdout.on("data", (data: Buffer) => { stdout.push(data); options.onData?.(data); });
    child.stderr.on("data", (data: Buffer) => { stderr.push(data); options.onData?.(data); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) reject(new Error("aborted"));
      else if (timedOut) reject(new Error(`timeout:${options.timeoutSeconds}`));
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code });
    });
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    }
  });
}

async function sshOk(command: string, input?: Buffer | string): Promise<Buffer> {
  const result = await sshRun(command, { input });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `SSH command failed (${result.exitCode})`);
  return result.stdout;
}

const RUNNER = String.raw`
import base64, json, os, pathlib, signal, subprocess, sys
cwd, token, encoded_command, encoded_env = sys.argv[1:5]
command = base64.b64decode(encoded_command).decode("utf-8")
env = os.environ.copy()
env.update(json.loads(base64.b64decode(encoded_env).decode("utf-8")))
root = pathlib.Path.home() / ".cache" / "pi-remote" / "processes"
root.mkdir(mode=0o700, parents=True, exist_ok=True)
pidfile = root / (token + ".pid")
process = subprocess.Popen(["/bin/bash", "-lc", command], cwd=cwd, env=env, start_new_session=True)
pidfile.write_text(str(process.pid))
os.chmod(pidfile, 0o600)
def stop(signum, frame):
    try: os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError: pass
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGHUP, stop)
try:
    code = process.wait()
finally:
    try: pidfile.unlink()
    except FileNotFoundError: pass
sys.exit(code)
`;

function encoded(value: string | object): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64");
}

function remoteBashOps(): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const token = randomUUID();
      const forwarded: Record<string, string> = {};
      for (const key of ["PI_SESSION_ID", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
        if (env?.[key]) forwarded[key] = String(env[key]);
      }
      forwarded.PI_REMOTE_EXECUTION_TARGET = TARGET_ID;
      const remoteCommand = [
        "python3", "-c", quote(RUNNER), quote(toRemote(cwd)), quote(token), quote(encoded(command)), quote(encoded(forwarded)),
      ].join(" ");
      const result = await sshRun(remoteCommand, { signal, timeoutSeconds: timeout, onData, token });
      return { exitCode: result.exitCode };
    },
  };
}

function readOps(): ReadOperations {
  return {
    readFile: (path) => sshOk(`cat -- ${quote(toRemote(path))}`),
    access: (path) => sshOk(`test -r ${quote(toRemote(path))}`).then(() => {}),
    detectImageMimeType: async (path) => {
      const result = await sshRun(`file --mime-type -b -- ${quote(toRemote(path))}`);
      if (result.exitCode !== 0) return null;
      const mime = result.stdout.toString().trim();
      return ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"].includes(mime) ? mime : null;
    },
  };
}

function writeOps(): WriteOperations {
  return {
    mkdir: (path) => sshOk(`mkdir -p -- ${quote(toRemote(path))}`).then(() => {}),
    writeFile: (path, content) => sshOk(`cat > ${quote(toRemote(path))}`, Buffer.from(content)).then(() => {}),
  };
}

function editOps(): EditOperations {
  const reads = readOps();
  const writes = writeOps();
  return {
    readFile: reads.readFile,
    writeFile: writes.writeFile,
    access: (path) => sshOk(`test -r ${quote(toRemote(path))} && test -w ${quote(toRemote(path))}`).then(() => {}),
  };
}

async function captureCommand(command: string, signal?: AbortSignal): Promise<{ text: string; exitCode: number | null }> {
  const chunks: Buffer[] = [];
  const result = await remoteBashOps().exec(command, LOCAL_CWD, { onData: (data) => chunks.push(data), signal });
  return { text: Buffer.concat(chunks).toString(), exitCode: result.exitCode };
}

async function remoteContext(): Promise<Array<{ path: string; content: string }>> {
  const script = String.raw`
import json, pathlib
cwd = pathlib.Path(${JSON.stringify(REMOTE_CWD)}).resolve()
result = []
chain = list(cwd.parents)[::-1] + [cwd]
for directory in chain:
    for name in ("AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"):
        path = directory / name
        if path.is_file():
            try: result.append({"path": str(path), "content": path.read_text()})
            except (OSError, UnicodeError): pass
            break
print(json.dumps(result))
`;
  const output = await sshOk(`python3 -c ${quote(script)}`);
  return JSON.parse(output.toString());
}

async function stageRemoteFile(path: string, directory: string): Promise<string> {
  const remotePath = toRemote(path);
  const localPath = join(directory, `${randomUUID()}-${basename(remotePath)}`);
  await writeFile(localPath, await sshOk(`cat -- ${quote(remotePath)}`), { mode: 0o600 });
  return localPath;
}

export default function workRemote(pi: ExtensionAPI) {
  const localRead = createReadTool(LOCAL_CWD);
  const localWrite = createWriteTool(LOCAL_CWD);
  const localEdit = createEditTool(LOCAL_CWD);
  const localBash = createBashTool(LOCAL_CWD);
  const localGrep = createGrepTool(LOCAL_CWD);
  const localFind = createFindTool(LOCAL_CWD);
  const localLs = createLsTool(LOCAL_CWD);
  let contexts: Array<{ path: string; content: string }> = [];

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      if (isCoreAssetPath((params as { path?: unknown }).path)) {
        return localRead.execute(id, params, signal, onUpdate, ctx);
      }
      return createReadTool(LOCAL_CWD, { operations: readOps() }).execute(id, params, signal, onUpdate, ctx);
    },
  });
  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      return createWriteTool(LOCAL_CWD, { operations: writeOps() }).execute(id, params, signal, onUpdate, ctx);
    },
  });
  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      return createEditTool(LOCAL_CWD, { operations: editOps() }).execute(id, params, signal, onUpdate, ctx);
    },
  });
  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const result: any = await createBashTool(LOCAL_CWD, { operations: remoteBashOps() }).execute(id, params, signal, onUpdate, ctx);
      const localOutput = result?.details?.fullOutputPath;
      if (localOutput) {
        try {
          const remoteDir = `${REMOTE_HOME}/.cache/pi-remote/output`;
          const remotePath = `${remoteDir}/${basename(localOutput)}`;
          await sshOk(`mkdir -p ${quote(remoteDir)} && chmod 700 ${quote(remoteDir)} && cat > ${quote(remotePath)} && chmod 600 ${quote(remotePath)}`, await readFile(localOutput));
          result.details.fullOutputPath = remotePath;
          for (const item of result.content || []) if (item.type === "text") item.text = String(item.text || "").replaceAll(localOutput, remotePath);
          await rm(localOutput, { force: true });
        } catch {}
      }
      return result;
    },
  });
  pi.registerTool({
    ...localGrep,
    async execute(_id, params: any, signal) {
      if (isCoreAssetPath(params.path)) return localGrep.execute(_id, params, signal);
      const searchPath = remoteInputPath(params.path);
      const limit = Math.max(1, Number(params.limit || 100));
      const args = ["rg", "--line-number", "--color=never", "--hidden"];
      if (params.ignoreCase) args.push("--ignore-case");
      if (params.literal) args.push("--fixed-strings");
      if (params.context > 0) args.push("--context", String(params.context));
      if (params.glob) args.push("--glob", String(params.glob));
      args.push("--", String(params.pattern), searchPath);
      const command = `${args.map(quote).join(" ")} | head -n ${limit}; code=\${PIPESTATUS[0]}; test "$code" -eq 0 -o "$code" -eq 1 -o "$code" -eq 141`;
      const output = await captureCommand(command, signal);
      if (output.exitCode !== 0) throw new Error(output.text.trim() || `grep failed (${output.exitCode})`);
      const text = output.text.trimEnd();
      const truncation = truncateHead(text);
      return { content: [{ type: "text", text: truncation.content || "No matches found" }], details: truncation.truncated ? { truncation } : undefined };
    },
  });
  pi.registerTool({
    ...localFind,
    async execute(_id, params: any, signal) {
      if (isCoreAssetPath(params.path)) return localFind.execute(_id, params, signal);
      const searchPath = remoteInputPath(params.path);
      const limit = Math.max(1, Number(params.limit || 1000));
      const command = `cd ${quote(searchPath)} && rg --files --hidden -g ${quote(String(params.pattern))} | head -n ${limit}; code=\${PIPESTATUS[0]}; test "$code" -eq 0 -o "$code" -eq 1 -o "$code" -eq 141`;
      const output = await captureCommand(command, signal);
      if (output.exitCode !== 0) throw new Error(output.text.trim() || `find failed (${output.exitCode})`);
      const text = output.text.trimEnd();
      const truncation = truncateHead(text);
      return { content: [{ type: "text", text: truncation.content || "No files found" }], details: truncation.truncated ? { truncation } : undefined };
    },
  });
  pi.registerTool({
    ...localLs,
    async execute(_id, params: any, signal) {
      if (isCoreAssetPath(params.path)) return localLs.execute(_id, params, signal);
      const path = remoteInputPath(params.path);
      const limit = Math.max(1, Number(params.limit || 500));
      const output = await captureCommand(`test -d ${quote(path)} && ls -A1p -- ${quote(path)} | head -n ${limit}`, signal);
      if (output.exitCode !== 0) throw new Error(output.text.trim() || `Not a directory: ${path}`);
      const text = output.text.trimEnd();
      const truncation = truncateHead(text);
      return { content: [{ type: "text", text: truncation.content || "Directory is empty" }], details: truncation.truncated ? { truncation } : undefined };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const probe = await sshRun(`cd ${quote(REMOTE_CWD)} && test -d .`);
    if (probe.exitCode !== 0) throw new Error(probe.stderr.toString().trim() || `Cannot access ${SSH}:${REMOTE_CWD}`);
    contexts = await remoteContext();
    ctx.ui.setStatus("work-remote", `${TARGET_ID.toUpperCase()}: ${SSH}:${REMOTE_CWD}`);
  });

  pi.on("before_agent_start", async (event) => {
    const contextText = contexts.map((file) => `<project_instructions path=${JSON.stringify(file.path)}>\n${file.content}\n</project_instructions>`).join("\n\n");
    const instructions = `Work environment session:\n- Your operational machine is ${MACHINE_NAME} (${SSH}); your current working directory is ${REMOTE_CWD}.\n- read, write, edit, bash, grep, find, and ls operate on ${MACHINE_NAME} automatically. Never prefix commands with ssh ${SSH}. Paths and shell effects refer to ${MACHINE_NAME}.\n- Your Pi agent core, session history, model/auth configuration, installed plugins, and control-plane tools run on a separate host that is not visible through those filesystem tools. Pi/plugin implementation files and core session paths may therefore be absent on ${MACHINE_NAME} even while those capabilities work.\n- Do not search ${MACHINE_NAME} for the local Pi installation when explaining this split. Do not move private core-side context into the work environment.\n- Plugin tools remain available from the core. When a plugin accepts work-file operands, the bridge stages those files ephemerally and removes the staging afterward.\n\nRemote project context:\n${contextText || "(none found)"}`;
    const systemPrompt = event.systemPrompt
      .replace(`Current working directory: ${LOCAL_CWD}`, `Current working directory: ${REMOTE_CWD}`)
      .replaceAll(LOCAL_CWD, REMOTE_CWD);
    return { systemPrompt: `${systemPrompt}\n\n${instructions}` };
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "gpt_chat") return;
    const input = event.input as { prompt_file?: string; files?: string[] };
    const candidates = [input.prompt_file, ...(Array.isArray(input.files) ? input.files : [])].filter((path): path is string => Boolean(path));
    if (!candidates.length) return;
    const directory = await mkdtemp(join(tmpdir(), "pi-work-stage-"));
    stagedByCall.set(event.toolCallId, directory);
    if (input.prompt_file) input.prompt_file = await stageRemoteFile(input.prompt_file, directory);
    if (Array.isArray(input.files)) input.files = await Promise.all(input.files.map((path) => stageRemoteFile(path, directory)));
  });

  pi.on("tool_result", async (event) => {
    const directory = stagedByCall.get(event.toolCallId);
    if (!directory) return;
    stagedByCall.delete(event.toolCallId);
    await rm(directory, { recursive: true, force: true });
  });

  pi.on("session_shutdown", async () => {
    await Promise.all([...stagedByCall.values()].map((directory) => rm(directory, { recursive: true, force: true })));
    stagedByCall.clear();
  });
}
