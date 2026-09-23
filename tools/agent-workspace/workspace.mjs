#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  closeSync,
  existsSync,
  openSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const DEFAULT_STATE = process.env.PI_WORKSPACE_STATE ?? path.join(
  process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"),
  "pi-workspaces",
  "registry.sqlite3",
);
const DEFAULT_CACHE_PATHS = [
  "node_modules",
  "**/node_modules",
  "dist",
  "**/dist",
  ".nx",
  ".react-router",
  "**/.react-router",
  ".converge-cache",
  "build",
  "**/build",
  "**/__pycache__",
  "**/.pytest_cache",
  "**/.mypy_cache",
  "**/.ruff_cache",
  ".lake",
  "**/.lake",
  // Cargo's build directory. Without it every Rust checkout fails release with "unclassified
  // ignored output" the first time anyone builds in it, which is every time. `stripCaches`
  // refuses to remove anything holding tracked files, so a repository that really does track a
  // directory called `target` is unaffected.
  "target",
  "**/target",
];
const DEFAULT_LEASE_SECONDS = 6 * 60 * 60;
const DEFAULT_MAX_COUNT = 0;
const DEFAULT_MIN_FREE_GIB = 30;
const DEFAULT_MIN_FREE_INODES_PERCENT = 10;

class CliError extends Error {}
class ResourceBusyError extends CliError {}

let inspectionDeadline;
function duringInspection(deadline, inspect) {
  const previous = inspectionDeadline;
  inspectionDeadline = deadline;
  try { return inspect(); } finally { inspectionDeadline = previous; }
}

function fail(message) {
  throw new CliError(message);
}

function parseArgs(argv) {
  const positional = [];
  const named = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    const name = equals === -1 ? value.slice(2) : value.slice(2, equals);
    let argument;
    if (equals !== -1) argument = value.slice(equals + 1);
    else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) {
      argument = argv[index + 1];
      index += 1;
    } else argument = "true";
    const values = named.get(name) ?? [];
    values.push(argument);
    named.set(name, values);
  }
  return { positional, named };
}

function one(args, name, fallback) {
  const values = args.named.get(name);
  if (values === undefined) return fallback;
  if (values.length !== 1) fail(`--${name} may be supplied only once`);
  return values[0];
}

function required(args, name) {
  const value = one(args, name);
  if (value === undefined || value.length === 0 || value === "true") fail(`--${name} is required`);
  return value;
}

function many(args, name) {
  return args.named.get(name) ?? [];
}

function bool(args, name) {
  const value = one(args, name, "false");
  if (value === "true") return true;
  if (value === "false") return false;
  fail(`--${name} must be true or false`);
}

function numberFlag(args, name, fallback) {
  const raw = one(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) fail(`--${name} must be a non-negative number`);
  return value;
}

function assertOnly(args, names) {
  const accepted = new Set(names);
  for (const name of args.named.keys()) if (!accepted.has(name)) fail(`unknown flag --${name}`);
}

function currentDirectory() {
  try {
    return process.cwd();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return undefined;
  }
}

function command(executable, commandArgs, options = {}) {
  const remaining = inspectionDeadline === undefined ? Infinity : inspectionDeadline - Date.now();
  if (remaining <= 0) fail("workspace inspection budget exhausted; no safety verdict was established");
  const result = spawnSync(executable, commandArgs, {
    // Git operands are resolved before launch; a released caller directory may vanish mid-command.
    cwd: options.cwd ?? homedir(),
    encoding: "utf8",
    input: options.input,
    stdio: ["pipe", "pipe", "pipe", ...heldResourceLocks.values()],
    env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 16 * 1024 * 1024,
    timeout: Math.max(1, Math.min(options.timeout ?? 30_000, remaining)),
    ...(inspectionDeadline === undefined ? {} : { killSignal: "SIGKILL" }),
  });
  if (inspectionDeadline !== undefined && result.error?.code === "ETIMEDOUT") {
    fail(`workspace inspection timed out: ${executable} ${commandArgs.join(" ")}; no safety verdict was established`);
  }
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error,
  };
}

function run(executable, commandArgs, options = {}) {
  const result = command(executable, commandArgs, options);
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || result.error?.message || `exit ${result.status}`;
    fail(`${executable} ${commandArgs.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

function git(workspace, args, options = {}) {
  return run("git", ["-C", workspace, ...args], options);
}

const registryPaths = new WeakMap();

const REGISTRY_SCHEMA_VERSION = 1;

function registrySchemaVersion(database) {
  const version = database.prepare("PRAGMA user_version").get().user_version;
  if (version > REGISTRY_SCHEMA_VERSION) fail(`workspace registry schema ${version} needs a newer agent-workspace`);
  return version;
}

function initializeRegistry(database) {
  if (database.prepare("PRAGMA journal_mode").get().journal_mode !== "wal") {
    database.exec("PRAGMA journal_mode = WAL");
  }
  if (registrySchemaVersion(database) === REGISTRY_SCHEMA_VERSION) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS workspace (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        root TEXT NOT NULL,
        kind TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('writer', 'review')),
        owner TEXT NOT NULL,
        repository TEXT,
        source_commit TEXT,
        checkout_type TEXT NOT NULL CHECK (checkout_type IN ('clone', 'worktree')),
        cache_paths TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        detail TEXT NOT NULL,
        group_id TEXT,
        creation_request TEXT
      );
      CREATE INDEX IF NOT EXISTS workspace_root ON workspace(root);
      CREATE INDEX IF NOT EXISTS workspace_lease ON workspace(lease_expires_at);
    `);
    const columns = database.prepare("PRAGMA table_info(workspace)").all();
    if (!columns.some((column) => column.name === "group_id")) {
      database.exec("ALTER TABLE workspace ADD COLUMN group_id TEXT");
    }
    if (!columns.some((column) => column.name === "creation_request")) {
      database.exec("ALTER TABLE workspace ADD COLUMN creation_request TEXT");
    }
    database.exec(`CREATE INDEX IF NOT EXISTS workspace_group ON workspace(group_id);
      PRAGMA user_version = ${REGISTRY_SCHEMA_VERSION}; COMMIT`);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function openRegistry(statePath = DEFAULT_STATE) {
  mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(statePath);
  registryPaths.set(database, statePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    if (registrySchemaVersion(database) !== REGISTRY_SCHEMA_VERSION ||
      database.prepare("PRAGMA journal_mode").get().journal_mode !== "wal") {
      withResourceLock(statePath, "registry-schema", () => initializeRegistry(database));
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function rowToRecord(row) {
  return {
    id: row.id,
    path: row.path,
    root: row.root,
    kind: row.kind,
    mode: row.mode,
    owner: row.owner,
    repository: row.repository,
    sourceCommit: row.source_commit,
    checkoutType: row.checkout_type,
    cachePaths: JSON.parse(row.cache_paths),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    leaseExpiresAt: row.lease_expires_at,
    state: row.state,
    detail: row.detail,
    groupId: row.group_id ?? null,
    ...(row.state === "creating" ? { creation: JSON.parse(row.creation_request) } : {}),
  };
}

function recordBy(database, selector) {
  const row = selector.id !== undefined
    ? database.prepare("SELECT * FROM workspace WHERE id = ?").get(selector.id)
    : database.prepare("SELECT * FROM workspace WHERE path = ?").get(path.resolve(selector.path));
  if (row === undefined) fail(`workspace not registered: ${selector.id ?? selector.path}`);
  return rowToRecord(row);
}

function listRecords(database, root) {
  const rows = root === undefined
    ? database.prepare("SELECT * FROM workspace ORDER BY root, path").all()
    : database.prepare("SELECT * FROM workspace WHERE root = ? ORDER BY path").all(path.resolve(root));
  return rows.map(rowToRecord);
}

function gitInfo(workspacePath) {
  const resolved = path.resolve(workspacePath);
  if (!existsSync(resolved)) fail(`workspace does not exist: ${resolved}`);
  if (git(resolved, ["rev-parse", "--is-inside-work-tree"]) !== "true") fail(`not a Git checkout: ${resolved}`);
  const top = path.resolve(git(resolved, ["rev-parse", "--show-toplevel"]));
  if (top !== resolved) fail(`workspace must be the Git root: ${resolved}`);
  const gitDirectory = path.resolve(git(resolved, ["rev-parse", "--absolute-git-dir"]));
  const rawCommon = git(resolved, ["rev-parse", "--git-common-dir"]);
  const commonDirectory = path.resolve(resolved, rawCommon);
  const repositoryResult = command("git", ["-C", resolved, "remote", "get-url", "origin"]);
  return {
    checkoutType: gitDirectory === commonDirectory ? "clone" : "worktree",
    repository: repositoryResult.status === 0 ? repositoryResult.stdout : null,
    head: git(resolved, ["rev-parse", "HEAD"]),
  };
}

function normalizeCachePath(value) {
  if (path.isAbsolute(value) || value.split(path.sep).includes("..")) fail(`cache path must be relative: ${value}`);
  const normalized = value.replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || /[?\[\]]/u.test(normalized) || (normalized.includes("*") && !/^\*\*\/[^*]+$/u.test(normalized))) {
    fail(`cache path supports only an exact path or **/directory: ${value}`);
  }
  return normalized;
}

function normalizeCachePaths(values) {
  const selected = [
    ...DEFAULT_CACHE_PATHS,
    ...values.flatMap((value) => value.split(",")),
  ];
  return [...new Set(selected.map((value) => value.trim()).filter(Boolean).map(normalizeCachePath))];
}

function repositoryOwnedCachePaths(repository, values) {
  const specifications = values.map((value) => {
    const separator = value.indexOf("=");
    if (separator < 1 || separator === value.length - 1) fail(`cache owner must be OUTPUT=TRACKED_SOURCE: ${value}`);
    const output = normalizeCachePath(value.slice(0, separator).trim());
    const source = normalizeCachePath(value.slice(separator + 1).trim());
    if (source.includes("*")) fail(`cache owner source must be an exact path: ${source}`);
    return { output, source, probes: [output, `${output}/.agent-workspace-cache-probe`] };
  });
  if (specifications.length === 0) return [];
  const sources = [...new Set(specifications.map(({ source }) => source))];
  const tracked = new Set(git(repository, ["ls-files", "-z", "--", ...sources]).split("\0").filter(Boolean));
  const probes = [...new Set(specifications.flatMap(({ output, probes: candidates, source }) =>
    tracked.has(source) && !output.startsWith("**/") ? candidates : []))];
  const ignored = probes.length === 0 ? new Set() : new Set(command("git", [
    "-C", repository, "check-ignore", "--no-index", "-z", "--stdin",
  ], { input: `${probes.join("\0")}\0` }).stdout.split("\0").filter(Boolean));
  return specifications
    .filter(({ output, source, probes: candidates }) => tracked.has(source)
      && (output.startsWith("**/") || candidates.some((candidate) => ignored.has(candidate))))
    .map(({ output }) => output);
}

function cachePathsForRepository(repository, args) {
  return normalizeCachePaths([
    ...many(args, "cache"),
    ...repositoryOwnedCachePaths(repository, many(args, "cache-owned")),
  ]);
}

const REFERENCE_CLONE_CONFIG = {
  "core.commitGraph": "false",
  "gc.writeCommitGraph": "false",
  "fetch.writeCommitGraph": "false",
  "gc.auto": "0",
  "maintenance.auto": "false",
};
const REFERENCE_GC_WARNINGS = new Set([
  "warning: attempting to write a commit-graph, but 'core.commitGraph' is disabled",
  "warning: There are too many unreachable loose objects; run 'git prune' to remove them.",
]);

function maintainReferenceClone(workspace, execute) {
  const gitDirectory = path.join(workspace, ".git");
  const alternates = path.join(gitDirectory, "objects", "info", "alternates");
  if (!existsSync(alternates) || !readFileSync(alternates, "utf8").trim()) return null;
  const configuration = git(workspace, ["config", "--local", "--null", "--list"]);
  const values = new Map(configuration.split("\0").filter(Boolean).map((entry) => {
    const separator = entry.indexOf("\n");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  const settings = Object.entries(REFERENCE_CLONE_CONFIG)
    .filter(([name, value]) => values.get(name.toLowerCase()) !== value);
  if (execute) for (const [name, value] of settings) git(workspace, ["config", "--local", "--replace-all", name, value]);
  const log = path.join(gitDirectory, "gc.log");
  let gcLog = "absent";
  if (existsSync(log)) {
    const contents = readFileSync(log, "utf8").trim();
    if (!contents || !contents.split(/\r?\n/u).every((line) => REFERENCE_GC_WARNINGS.has(line))) {
      fail(`unrecognized Git maintenance failure retained at ${log}; inspect it before repair`);
    }
    if (existsSync(path.join(gitDirectory, "gc.pid"))) {
      fail(`Git maintenance still owns ${gitDirectory}/gc.pid; retry after it finishes`);
    }
    gcLog = execute ? "removed-diagnosed-warning" : "would-remove-diagnosed-warning";
    if (execute) rmSync(log);
  }
  return { path: workspace, settings: settings.map(([name]) => name), gcLog };
}

function register(database, input) {
  return withWorkspaceLock(database, input.path, () => registerWorkspace(database, input), input.groupId);
}

function registrationInspection(workspace) {
  const info = gitInfo(workspace);
  maintainReferenceClone(workspace, true);
  return info;
}

function registerWorkspace(database, input, inspectedInfo) {
  const info = inspectedInfo ?? registrationInspection(input.path);
  const now = Date.now();
  const existing = database.prepare("SELECT * FROM workspace WHERE path = ?").get(path.resolve(input.path));
  if (existing?.state === "creating") return rowToRecord(existing);
  if (existing !== undefined && existing.state !== "released") {
    if (input.groupId != null && existing.group_id !== null && existing.group_id !== input.groupId) {
      fail(`workspace ${path.resolve(input.path)} already belongs to group ${existing.group_id}; requested ${input.groupId}`);
    }
    const cachePaths = input.replaceCachePaths
      ? input.cachePaths
      : [...new Set([...JSON.parse(existing.cache_paths), ...input.cachePaths])];
    const groupId = input.groupId ?? existing.group_id;
    database.prepare("UPDATE workspace SET cache_paths = ?, group_id = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(cachePaths), groupId, now, existing.id);
    return recordBy(database, { id: existing.id });
  }
  if (existing !== undefined) database.prepare("DELETE FROM workspace WHERE id = ?").run(existing.id);
  const record = {
    id: randomUUID(),
    path: path.resolve(input.path),
    root: path.resolve(input.root ?? path.dirname(input.path)),
    kind: input.kind,
    mode: input.mode,
    owner: input.owner,
    repository: info.repository,
    sourceCommit: input.sourceCommit ?? null,
    checkoutType: info.checkoutType,
    cachePaths: input.cachePaths,
    createdAt: now,
    updatedAt: now,
    leaseExpiresAt: input.leaseExpiresAt ?? now + input.leaseSeconds * 1000,
    state: "active",
    detail: "lease registered",
    groupId: input.groupId ?? null,
  };
  database.prepare(`
    INSERT INTO workspace (
      id, path, root, kind, mode, owner, repository, source_commit,
      checkout_type, cache_paths, created_at, updated_at,
      lease_expires_at, state, detail, group_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id, record.path, record.root, record.kind, record.mode, record.owner,
    record.repository, record.sourceCommit, record.checkoutType,
    JSON.stringify(record.cachePaths), record.createdAt, record.updatedAt,
    record.leaseExpiresAt, record.state, record.detail, record.groupId,
  );
  return record;
}

function selectorFrom(args) {
  const id = one(args, "id");
  const selectedPath = one(args, "path");
  if ((id === undefined) === (selectedPath === undefined)) fail("supply exactly one of --id or --path");
  return id === undefined ? { path: selectedPath } : { id };
}

function updateState(database, record, state, detail) {
  const now = Date.now();
  database.prepare("UPDATE workspace SET state = ?, detail = ?, updated_at = ? WHERE id = ?")
    .run(state, detail, now, record.id);
  return { ...record, state, detail, updatedAt: now };
}

function processAncestry() {
  const ignored = new Set([process.pid, process.ppid]);
  let candidate = process.ppid;
  while (candidate > 1) {
    try {
      const status = readFileSync(`/proc/${candidate}/status`, "utf8");
      const match = status.match(/^PPid:\s+(\d+)/mu);
      if (match === null) break;
      candidate = Number(match[1]);
      if (ignored.has(candidate)) break;
      ignored.add(candidate);
    } catch {
      break;
    }
  }
  return ignored;
}

function readLink(file) {
  try {
    return readlinkSync(file).replace(/ \(deleted\)$/u, "");
  } catch {
    return null;
  }
}

function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function processSnapshot() {
  if (!existsSync("/proc")) return [];
  const ignored = processAncestry();
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  const processes = [];
  let entries;
  try { entries = readdirSync("/proc"); } catch { return []; }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    if (ignored.has(pid)) continue;
    const root = `/proc/${pid}`;
    try {
      const status = readFileSync(`${root}/status`, "utf8");
      const owner = Number(status.match(/^Uid:\s+(\d+)/mu)?.[1]);
      if (owner !== uid) continue;
      const commandLine = readFileSync(`${root}/cmdline`, "utf8").split("\0").filter(Boolean);
      processes.push({
        pid,
        command: commandLine[0] ?? "unknown",
        commandLine,
        cwd: readLink(`${root}/cwd`),
        executable: readLink(`${root}/exe`),
      });
    } catch {
      continue;
    }
  }
  return processes;
}

function processReferences(workspacePath, snapshot = processSnapshot()) {
  return snapshot.flatMap((processRecord) => {
    const matches = [];
    if (processRecord.cwd !== null && within(workspacePath, processRecord.cwd)) matches.push(`cwd:${processRecord.cwd}`);
    if (processRecord.executable !== null && within(workspacePath, processRecord.executable)) matches.push(`exe:${processRecord.executable}`);
    if (processRecord.commandLine.some((argument) => argument === workspacePath || argument.includes(`${workspacePath}/`) || argument.includes(`=${workspacePath}`))) matches.push("argument");
    return matches.length === 0 ? [] : [{ pid: processRecord.pid, command: processRecord.command, matches }];
  });
}

function dockerEndpointScope(endpoint, {
  uid = process.getuid?.(),
  inspect = statSync,
  writable = (file) => accessSync(file, constants.W_OK),
} = {}) {
  if (!endpoint.startsWith("unix://")) return { inspect: true };
  const socketPath = endpoint.slice("unix://".length);
  if (!path.isAbsolute(socketPath)) return { error: "Docker Unix endpoint must have an absolute socket path" };
  let socket;
  try {
    socket = inspect(socketPath);
  } catch (error) {
    return { error: `Docker Unix socket metadata failed: ${error.code ?? "unknown"}` };
  }
  if (!socket.isSocket()) return { error: "Docker Unix endpoint is not a socket" };
  try {
    writable(socketPath);
  } catch (error) {
    // A foreign daemon without a connect grant cannot own this account's Docker work.
    // Failure at an owned or otherwise authorized endpoint remains an inspection failure.
    if (error.code === "EACCES" && uid !== undefined && uid !== 0 && socket.uid !== uid) {
      return { inspect: false, reason: "foreign-owned-socket-without-connect-grant" };
    }
    return { error: `Docker Unix socket access failed: ${error.code ?? "unknown"}` };
  }
  return { inspect: true };
}

function dockerSnapshot(execute = command, { env = process.env, endpointScope = dockerEndpointScope } = {}) {
  const context = execute("docker", ["context", "inspect", ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : []),
    "--format", "{{json .Endpoints.docker.Host}}"], { timeout: 10_000 });
  if (context.error?.code === "ENOENT") return { containers: [], available: false };
  if (context.status !== 0) return { containers: [], available: true, error: context.stderr || context.stdout || "docker context inspect failed" };
  let endpoint;
  try {
    endpoint = !env.DOCKER_CONTEXT && env.DOCKER_HOST ? env.DOCKER_HOST : JSON.parse(context.stdout);
    if (typeof endpoint !== "string" || endpoint.length === 0) throw new Error("missing endpoint");
  } catch {
    return { containers: [], available: true, error: "docker context inspect returned an invalid endpoint" };
  }
  const scope = endpointScope(endpoint);
  if (scope.error) return { containers: [], available: true, error: scope.error };
  if (!scope.inspect) return { containers: [], available: false, reason: scope.reason };
  const listed = execute("docker", ["ps", "--all", "--quiet", "--no-trunc"], { timeout: 10_000 });
  if (listed.error?.code === "ENOENT") return { containers: [], available: false };
  if (listed.status !== 0) return { containers: [], available: true, error: listed.stderr || listed.stdout || "docker ps failed" };
  const containers = [];
  for (const id of listed.stdout.split(/\s+/u).filter(Boolean)) {
    const inspected = execute("docker", ["inspect", id], { timeout: 20_000 });
    const detail = inspected.stderr || inspected.stdout || "docker inspect failed";
    if (inspected.status !== 0 && /no such object/iu.test(detail)) continue;
    if (inspected.status !== 0) return { containers: [], available: true, error: detail };
    try {
      const parsed = JSON.parse(inspected.stdout);
      if (!Array.isArray(parsed)) return { containers: [], available: true, error: "docker inspect returned invalid JSON" };
      containers.push(...parsed);
    } catch {
      return { containers: [], available: true, error: "docker inspect returned invalid JSON" };
    }
  }
  return { containers, available: true };
}

function dockerReferences(workspacePath, snapshot = dockerSnapshot()) {
  if (snapshot.error !== undefined) return { references: [], available: snapshot.available, error: snapshot.error };
  const references = [];
  for (const container of snapshot.containers) {
    const state = container?.State?.Status ?? "unknown";
    const restart = container?.HostConfig?.RestartPolicy?.Name ?? "unknown";
    if (state === "exited" && restart === "no") continue;
    const workingDirectory = container?.Config?.Labels?.["com.docker.compose.project.working_dir"];
    const mounts = Array.isArray(container?.Mounts) ? container.Mounts : [];
    const sources = mounts
      .filter((mount) => mount?.Type === "bind" && typeof mount?.Source === "string" && within(workspacePath, mount.Source))
      .map((mount) => mount.Source);
    if ((typeof workingDirectory !== "string" || !within(workspacePath, workingDirectory)) && sources.length === 0) continue;
    references.push({
      id: container.Id,
      name: String(container.Name ?? "unknown").replace(/^\//u, ""),
      state,
      restart,
      workingDirectory: typeof workingDirectory === "string" ? workingDirectory : null,
      sources,
    });
  }
  return { references, available: snapshot.available };
}

function parseSystemdUnits(output, manager) {
  return output.split(/\n\s*\n/u).flatMap((block) => {
    const properties = new Map(block.split("\n").flatMap((line) => {
      const separator = line.indexOf("=");
      return separator === -1 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
    }));
    const id = properties.get("Id");
    const activeState = properties.get("ActiveState");
    if (id === undefined || activeState === undefined || !["active", "activating", "reloading", "deactivating"].includes(activeState)) return [];
    const rawWorkingDirectory = properties.get("WorkingDirectory") ?? "";
    return [{
      id,
      manager,
      activeState,
      workingDirectory: rawWorkingDirectory.replace(/^[!+~-]+/u, "") || null,
      execStart: properties.get("ExecStart") ?? "",
    }];
  });
}

function systemdManagerSnapshot(manager, execute = command) {
  const managerArgs = manager === "user" ? ["--user"] : [];
  const listed = execute("systemctl", [
    ...managerArgs,
    "list-units",
    "--all",
    "--state=active,activating,reloading,deactivating",
    "--type=service",
    "--type=scope",
    "--no-legend",
    "--plain",
  ], { timeout: 20_000 });
  if (listed.error?.code === "ENOENT" || /not been booted with systemd|failed to connect to (?:user scope )?bus|(?:DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR) not defined/iu.test(listed.stderr)) {
    return { units: [], available: false };
  }
  if (listed.status !== 0) return { units: [], available: true, error: listed.stderr || listed.stdout || "systemctl list-units failed" };
  const unitIds = listed.stdout.split("\n").map((line) => line.trim().split(/\s+/u)[0]).filter(Boolean);
  if (unitIds.length === 0) return { units: [], available: true };
  const shown = execute("systemctl", [
    ...managerArgs,
    "show",
    ...unitIds,
    "--property=Id",
    "--property=ActiveState",
    "--property=WorkingDirectory",
    "--property=ExecStart",
  ], { timeout: 20_000 });
  if (shown.status !== 0) return { units: [], available: true, error: shown.stderr || shown.stdout || "systemctl show failed" };
  return { units: parseSystemdUnits(shown.stdout, manager), available: true };
}

function systemdSnapshot() {
  const user = systemdManagerSnapshot("user");
  const system = systemdManagerSnapshot("system");
  const errors = [user.error, system.error].filter(Boolean);
  return {
    units: [...user.units, ...system.units],
    available: user.available || system.available,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

function serializedPathReference(serialized, workspacePath) {
  return serialized === workspacePath || serialized.includes(`${workspacePath}/`) ||
    serialized.includes(`=${workspacePath}`) || serialized.includes(` ${workspacePath} `);
}

function systemdReferences(workspacePath, snapshot = systemdSnapshot()) {
  if (snapshot.error !== undefined) return { references: [], available: snapshot.available, error: snapshot.error };
  return {
    available: snapshot.available,
    references: snapshot.units.filter((unit) =>
      (unit.workingDirectory !== null && within(workspacePath, unit.workingDirectory)) ||
      serializedPathReference(unit.execStart, workspacePath)),
  };
}

function gitDependencySnapshot(database) {
  const alternates = [];
  const linkedWorktrees = [];
  for (const record of listRecords(database)) {
    if (!existsSync(record.path)) continue;
    let commonDirectory = path.join(record.path, ".git");
    if (record.checkoutType === "worktree") {
      const common = command("git", ["-C", record.path, "rev-parse", "--git-common-dir"]);
      if (common.status !== 0) fail(`cannot inspect linked worktree ${record.path}: ${common.stderr || common.error?.message || `exit ${common.status}`}`);
      commonDirectory = path.resolve(record.path, common.stdout);
      linkedWorktrees.push({ recordId: record.id, workspacePath: record.path, commonDirectory });
    }
    const objectDirectory = path.join(commonDirectory, "objects");
    const alternatesPath = path.join(objectDirectory, "info", "alternates");
    if (!existsSync(alternatesPath)) continue;
    let contents;
    try { contents = readFileSync(alternatesPath, "utf8"); } catch { continue; }
    for (const alternate of contents.split("\n").filter(Boolean)) {
      alternates.push({
        recordId: record.id,
        workspacePath: record.path,
        objectDirectory: path.resolve(objectDirectory, alternate),
      });
    }
  }
  return { alternates, linkedWorktrees };
}

function safetySnapshot(database) {
  const isolated = process.env.NODE_TEST_CONTEXT !== undefined &&
    process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY === "empty";
  const gitDependencies = gitDependencySnapshot(database);
  return {
    processes: isolated ? [] : processSnapshot(),
    docker: isolated ? { containers: [], available: false } : dockerSnapshot(),
    systemd: isolated ? { units: [], available: false } : systemdSnapshot(),
    gitAlternates: gitDependencies.alternates,
    linkedWorktrees: gitDependencies.linkedWorktrees,
  };
}

function directoryHasEntries(directory) {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return true; }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path.join(current, entry.name));
      else return true;
    }
  }
  return false;
}

function gitStatusExcludingNested(record, args, nestedWorkspaces = []) {
  const exclusions = nestedWorkspaces.flatMap((workspace) => {
    const relative = path.relative(record.path, workspace);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail(`nested workspace is outside ${record.path}: ${workspace}`);
    return [`:(exclude,top,literal)${relative}`, `:(exclude,top,glob)${relative}/**`];
  });
  return git(record.path, [...args, "--", ".", ...exclusions]);
}

function gitDisposition(record, nestedWorkspaces = []) {
  const lines = gitStatusExcludingNested(record, ["status", "--porcelain=v1", "--ignored=matching", "--untracked-files=normal"], nestedWorkspaces).split("\n");
  const changed = lines.filter((line) => line && !line.startsWith("!! "));
  if (changed.length > 0) return { safe: false, reason: `working tree has changes: ${changed.slice(0, 8).join(" | ")}` };
  const nestedRelativePaths = nestedWorkspaces.map((workspace) => path.relative(record.path, workspace));
  const ignored = lines
    .filter((line) => line.startsWith("!! "))
    .filter((line) => !nestedRelativePaths.includes(line.slice(3).replace(/\/$/u, "")))
    .filter((line) => {
      const candidate = path.resolve(record.path, line.slice(3).replace(/\/$/u, ""));
      try { return existsSync(candidate) && directoryHasEntries(candidate); } catch { return true; }
    });
  if (ignored.length > 0) return { safe: false, reason: `checkout has unclassified ignored output: ${ignored.slice(0, 8).join(" | ")}` };
  const head = git(record.path, ["rev-parse", "HEAD"]);
  if (record.sourceCommit !== null && head === record.sourceCommit) return { safe: true, reason: "checkout remains at its durable source commit", head };
  const refs = record.checkoutType === "clone"
    ? git(record.path, ["for-each-ref", "--format=%(refname)", "refs/heads"])
      .split("\n")
      .filter(Boolean)
    : [];
  const candidates = [...refs, "HEAD"];
  const local = [];
  for (const ref of candidates) {
    const count = Number(git(record.path, ["rev-list", "--count", ref, "--not", "--remotes"]));
    if (count > 0) local.push(`${ref}:${count}`);
  }
  if (local.length > 0) return { safe: false, reason: `checkout has commits absent from remote refs: ${local.join(", ")}`, head };
  return { safe: true, reason: "every local branch commit exists on a remote ref", head };
}

function gcDestination(statePath, record, suffix) {
  const root = path.join(path.dirname(statePath), "gc");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return path.join(root, `${record.id}-${suffix}-${Date.now()}`);
}

function spawnRemoval(target) {
  const script = [
    "const fs = require('node:fs');",
    "const os = require('node:os');",
    "const cp = require('node:child_process');",
    "try { os.setPriority(0, 19); } catch {}",
    "try { fs.rmSync(process.argv[1], { recursive: true, force: true }); }",
    "catch { cp.spawnSync('sudo', ['-n', 'rm', '-rf', '--', process.argv[1]], { stdio: 'ignore' }); }",
  ].join("");
  const child = spawn(process.execPath, ["-e", script, target], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function drainGc(statePath) {
  const root = path.join(path.dirname(statePath), "gc");
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.isFile() || entry.isSymbolicLink()) spawnRemoval(path.join(root, entry.name));
  }
}

function repairCacheOwnership(target) {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) fail(`cannot repair cache ownership without a numeric user and group: ${target}`);
  run("sudo", ["-n", "chown", "-R", `${uid}:${gid}`, "--", target], { timeout: 120_000 });
}

function moveToGc(target, destination) {
  try {
    renameSync(target, destination);
    spawnRemoval(destination);
  } catch (error) {
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      repairCacheOwnership(target);
      renameSync(target, destination);
      spawnRemoval(destination);
      return;
    }
    if (error?.code !== "EXDEV") throw error;
    rmSync(target, { recursive: true, force: true });
  }
}

function* cacheTargets(workspacePath, cachePaths, readDirectory = readdirSync) {
  const directoryNames = new Set();
  for (const relative of cachePaths) {
    if (relative.startsWith("**/")) directoryNames.add(relative.slice(3));
    else yield path.resolve(workspacePath, relative);
  }
  const pending = directoryNames.size === 0 ? [] : [workspacePath];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = readDirectory(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name === ".git") continue;
      const candidate = path.join(current, entry.name);
      // A **/name declaration names generated output wherever it appears: a
      // directory such as node_modules or a single file such as
      // client.generated.ts. Tracked files are protected by the consumer.
      if (directoryNames.has(entry.name)) yield candidate;
      if (!entry.isDirectory()) continue;
      // The consumer removes generated trees before traversal resumes. Tracked
      // directories stay in place and may contain other generated caches.
      if (existsSync(candidate)) pending.push(candidate);
    }
  }
}

/* A declared cache path may collide with a directory the repository actually tracks, such as a
 * committed `build`. Generated output is never tracked, so tracked content is not the cache. */
function holdsTrackedFiles(target) {
  const directory = lstatSync(target).isDirectory();
  const cwd = directory ? target : path.dirname(target);
  const pathspec = directory ? "." : `:(literal)${path.basename(target)}`;
  const result = command("git", ["-C", cwd, "ls-files", "--", pathspec]);
  if (result.status !== 0) return true;
  return result.stdout.length > 0;
}

const REPOSITORY_CACHE_MANIFEST = ".agent-workspace-caches";

/* A repository can declare its own generated output in a tracked manifest, one cache path per
 * line, `#` comments allowed. Reading it from HEAD rather than the working tree means an agent
 * cannot launder unique work by dropping an untracked manifest into the checkout; the
 * declaration has to be part of the repository's history. Every caller that creates a workspace
 * for that repository then classifies its output the same way, without repeating `--cache`. */
function repositoryManifestCachePaths(workspacePath) {
  const result = command("git", ["-C", workspacePath, "show", `HEAD:${REPOSITORY_CACHE_MANIFEST}`]);
  if (result.status !== 0) return [];
  const declared = result.stdout
    .split("\n")
    .map((line) => line.replace(/#.*$/u, "").trim())
    .filter(Boolean);
  const accepted = [];
  for (const value of declared) {
    try {
      accepted.push(normalizeCachePath(value));
    } catch {
      process.stderr.write(`agent-workspace: ignoring invalid ${REPOSITORY_CACHE_MANIFEST} entry in ${workspacePath}: ${value}\n`);
    }
  }
  return accepted;
}

function effectiveCachePaths(record) {
  return [...new Set([...record.cachePaths, ...repositoryManifestCachePaths(record.path)])];
}

function stripCaches(record, statePath) {
  const removed = [];
  const seen = new Set();
  for (const target of cacheTargets(record.path, effectiveCachePaths(record))) {
    if (seen.has(target) || !within(record.path, target) || target === record.path || !existsSync(target)) continue;
    seen.add(target);
    if (holdsTrackedFiles(target)) continue;
    const cacheKey = createHash("sha256").update(path.relative(record.path, target)).digest("hex").slice(0, 12);
    const destination = gcDestination(statePath, record, `${path.basename(target)}-${cacheKey}`);
    moveToGc(target, destination);
    removed.push(path.relative(record.path, target));
  }
  return removed;
}

function killProcessReferences(references) {
  for (const reference of references) {
    try { process.kill(reference.pid, "SIGTERM"); } catch {}
  }
  const until = Date.now() + 2_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < until) {
    if (references.every((reference) => {
      try { process.kill(reference.pid, 0); return false; } catch { return true; }
    })) return;
    Atomics.wait(pause, 0, 0, 50);
  }
  for (const reference of references) {
    try { process.kill(reference.pid, "SIGKILL"); } catch {}
  }
}

function removeDockerReferences(references) {
  if (references.length === 0) return;
  run("docker", ["rm", "--force", ...references.map((reference) => reference.id)], { timeout: 30_000 });
}

function stopSystemdReferences(references) {
  const systemUnits = references.filter((reference) => reference.manager === "system");
  if (systemUnits.length > 0) {
    fail(`system units require their owning service lifecycle: ${systemUnits.map((unit) => unit.id).join(", ")}`);
  }
  const userUnits = references.filter((reference) => reference.manager === "user");
  if (userUnits.length > 0) {
    run("systemctl", ["--user", "stop", ...userUnits.map((unit) => unit.id)], { timeout: 30_000 });
  }
}

function removeWorkspace(record, statePath) {
  if (record.checkoutType === "worktree") {
    const rawCommon = git(record.path, ["rev-parse", "--git-common-dir"]);
    const common = path.resolve(record.path, rawCommon);
    const branchResult = command("git", ["-C", record.path, "symbolic-ref", "--quiet", "--short", "HEAD"]);
    run("git", [`--git-dir=${common}`, "worktree", "remove", "--force", record.path]);
    if (branchResult.status === 0) run("git", [`--git-dir=${common}`, "branch", "--delete", "--force", branchResult.stdout]);
    return;
  }
  const destination = gcDestination(statePath, record, "workspace");
  moveToGc(record.path, destination);
}

function removeEmptyWorkspaceContainer(record) {
  const container = path.dirname(record.path);
  if (path.dirname(container) !== record.root) return;
  try { rmdirSync(container); } catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes(error?.code)) throw error;
  }
}

function inspectRecord(record, options = {}) {
  if (record.state === "creating") {
    return { classification: "blocked", reason: "creation is pending; repeat the original create command to resume", processes: [], containers: [], systemdUnits: [] };
  }
  const now = options.now ?? Date.now();
  if (!existsSync(record.path)) return { classification: "missing", reason: "checkout path is absent", processes: [], containers: [], systemdUnits: [] };
  if (record.leaseExpiresAt > now && !options.ignoreLease) {
    return { classification: "active", reason: `lease valid until ${new Date(record.leaseExpiresAt).toISOString()}`, processes: [], containers: [], systemdUnits: [] };
  }
  const processes = processReferences(record.path, options.safety?.processes);
  const docker = dockerReferences(record.path, options.safety?.docker);
  const systemd = systemdReferences(record.path, options.safety?.systemd);
  const objectDirectory = record.checkoutType === "clone" ? path.join(record.path, ".git", "objects") : null;
  const gitDependents = objectDirectory === null ? [] : (options.safety?.gitAlternates ?? [])
    .filter((reference) => reference.recordId !== record.id && reference.objectDirectory === objectDirectory);
  const linkedDependents = record.checkoutType === "clone" ? (options.safety?.linkedWorktrees ?? [])
    .filter((reference) => reference.recordId !== record.id && reference.commonDirectory === path.join(record.path, ".git")) : [];
  if (gitDependents.length > 0 || linkedDependents.length > 0) {
    return {
      classification: "referenced",
      reason: linkedDependents.length === 0
        ? `${gitDependents.length} registered Git checkout(s) still borrow this checkout's objects: ${gitDependents.map((reference) => reference.workspacePath).join(", ")}`
        : `${linkedDependents.length} registered linked worktree(s) still use this checkout's Git directory: ${linkedDependents.map((reference) => reference.workspacePath).join(", ")}${gitDependents.length ? `; ${gitDependents.length} alternate object borrower(s)` : ""}`,
      processes,
      containers: docker.references,
      systemdUnits: systemd.references,
      gitDependents: [...gitDependents, ...linkedDependents],
    };
  }
  if (docker.error !== undefined) return { classification: "blocked", reason: `cannot prove container safety: ${docker.error}`, processes, containers: [], systemdUnits: [] };
  if (systemd.error !== undefined) return { classification: "blocked", reason: `cannot prove systemd safety: ${systemd.error}`, processes, containers: docker.references, systemdUnits: [] };
  if (processes.length > 0 || docker.references.length > 0 || systemd.references.length > 0) {
    return {
      classification: "referenced",
      reason: `${processes.length} process, ${docker.references.length} container, and ${systemd.references.length} systemd references remain`,
      processes,
      containers: docker.references,
      systemdUnits: systemd.references,
    };
  }
  const disposition = duringInspection(options.deadline, () => gitDisposition(record, options.nestedWorkspaces));
  return {
    classification: disposition.safe ? "reclaimable" : "repair-required",
    reason: disposition.reason,
    processes,
    containers: docker.references,
    systemdUnits: systemd.references,
    head: disposition.head,
  };
}

function reconcileRecord(database, record, options) {
  let safety = options.safety;
  let inspection = inspectRecord(record, { ignoreLease: options.ignoreLease, safety, deadline: options.deadline });
  if (inspection.classification === "active") return { record, inspection, action: "none" };
  if (inspection.classification === "missing") {
    if (options.execute) {
      updateState(database, record, "released", inspection.reason);
      removeEmptyWorkspaceContainer(record);
    }
    return { record, inspection, action: options.execute ? "forgot-missing" : "would-forget-missing" };
  }
  if (inspection.classification === "referenced" && options.execute && options.reapExpired) {
    const current = recordBy(database, { id: record.id });
    if (current.leaseExpiresAt > Date.now()) return { record: current, inspection: inspectRecord(current), action: "lease-renewed" };
    updateState(database, current, "reclaiming", "expired lease is fencing live references");
    stopSystemdReferences(inspection.systemdUnits);
    removeDockerReferences(inspection.containers);
    killProcessReferences(inspection.processes);
    safety = safetySnapshot(database);
    inspection = inspectRecord({ ...current, state: "reclaiming" }, { ignoreLease: true, safety, deadline: options.deadline });
  }
  if (inspection.classification === "referenced" || inspection.classification === "blocked") {
    if (options.execute) updateState(database, record, inspection.classification, inspection.reason);
    return { record, inspection, action: "none" };
  }
  let removedCaches = [];
  if (options.execute) {
    removedCaches = stripCaches(record, options.statePath);
    inspection = inspectRecord(record, { ignoreLease: true, safety, deadline: options.deadline });
  }
  if (inspection.classification === "repair-required") {
    if (options.execute) updateState(database, record, "repair-required", inspection.reason);
    return { record, inspection, action: removedCaches.length > 0 ? `removed-caches:${removedCaches.join(",")}` : "none" };
  }
  if (inspection.classification !== "reclaimable") return { record, inspection, action: "none" };
  if (!options.execute) return { record, inspection, action: "would-release" };
  const current = recordBy(database, { id: record.id });
  if (!options.ignoreLease && current.leaseExpiresAt > Date.now()) return { record: current, inspection: inspectRecord(current), action: "lease-renewed" };
  updateState(database, current, "reclaiming", inspection.reason);
  removeWorkspace(current, options.statePath);
  removeEmptyWorkspaceContainer(current);
  updateState(database, current, "released", inspection.reason);
  return { record: current, inspection, action: "released" };
}

function recordsInGroup(database, record) {
  if (record.groupId === null) return [record];
  return database.prepare("SELECT * FROM workspace WHERE group_id = ? ORDER BY root, path")
    .all(record.groupId)
    .map(rowToRecord)
    .filter((candidate) => candidate.state !== "released" || existsSync(candidate.path));
}

function groupInspectionOptions(record, records, options) {
  return {
    ...options,
    nestedWorkspaces: records
      .filter((candidate) => candidate.id !== record.id && within(record.path, candidate.path))
      .map((candidate) => candidate.path),
  };
}

function groupReconciliation(database, records, options) {
  const now = Date.now();
  let safety = options.safety;
  const groupId = records[0]?.groupId;
  if (!options.ignoreLease && records.some((record) => record.leaseExpiresAt > now)) {
    const expires = Math.max(...records.map((record) => record.leaseExpiresAt));
    return records.map((record) => ({
      record,
      inspection: { classification: "active", reason: `group lease valid until ${new Date(expires).toISOString()}`, processes: [], containers: [], systemdUnits: [] },
      action: "none",
    }));
  }

  let inspections = records.map((record) => inspectRecord(record,
    groupInspectionOptions(record, records, { ignoreLease: true, safety, deadline: options.deadline })));
  if (options.execute && options.reapExpired && inspections.some((inspection) => inspection.classification === "referenced")) {
    const current = records.map((record) => recordBy(database, { id: record.id }));
    if (!options.ignoreLease && current.some((record) => record.leaseExpiresAt > Date.now())) {
      return groupReconciliation(database, current, { ...options, execute: false });
    }
    const systemUnits = inspections.flatMap((inspection) => inspection.systemdUnits);
    stopSystemdReferences(systemUnits);
    removeDockerReferences(inspections.flatMap((inspection) => inspection.containers));
    killProcessReferences(inspections.flatMap((inspection) => inspection.processes));
    safety = safetySnapshot(database);
    inspections = records.map((record) => inspectRecord(record,
      groupInspectionOptions(record, records, { ignoreLease: true, safety, deadline: options.deadline })));
  }

  const removedCaches = new Map();
  if (options.execute && !inspections.some((inspection) => ["referenced", "blocked"].includes(inspection.classification))) {
    records.forEach((record, index) => {
      if (inspections[index].classification !== "missing") removedCaches.set(record.id, stripCaches(record, options.statePath));
    });
    inspections = records.map((record) => inspectRecord(record,
      groupInspectionOptions(record, records, { ignoreLease: true, safety, deadline: options.deadline })));
  }

  const releasable = inspections.every((inspection) => ["missing", "reclaimable"].includes(inspection.classification));
  if (!releasable) {
    if (options.execute) {
      records.forEach((record, index) => {
        const inspection = inspections[index];
        const state = inspection.classification === "reclaimable" ? "blocked" : inspection.classification;
        updateState(database, record, state, `workspace group ${groupId} retained: ${inspection.reason}`);
      });
    }
    return records.map((record, index) => ({
      record,
      inspection: inspections[index],
      action: (removedCaches.get(record.id) ?? []).length > 0
        ? `removed-caches:${removedCaches.get(record.id).join(",")}`
        : "none",
    }));
  }
  if (!options.execute) {
    return records.map((record, index) => ({ record, inspection: inspections[index], action: "would-release-group" }));
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const current = records.map((record) => recordBy(database, { id: record.id }));
    if (!options.ignoreLease && current.some((record) => record.leaseExpiresAt > Date.now())) {
      database.exec("ROLLBACK");
      return groupReconciliation(database, current, { ...options, execute: false });
    }
    const statement = database.prepare("UPDATE workspace SET state = 'reclaiming', detail = ?, updated_at = ? WHERE id = ?");
    const updatedAt = Date.now();
    for (const record of current) statement.run(`workspace group ${groupId} is reclaiming`, updatedAt, record.id);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }

  records
    .map((record, index) => ({ record, inspection: inspections[index] }))
    .sort((left, right) => right.record.path.length - left.record.path.length)
    .forEach(({ record, inspection }) => {
      if (inspection.classification === "reclaimable" && existsSync(record.path)) removeWorkspace(record, options.statePath);
      updateState(database, record, "released", `workspace group ${groupId} released: ${inspection.reason}`);
    });
  for (const record of records) removeEmptyWorkspaceContainer(record);
  return records.map((record, index) => ({ record, inspection: inspections[index], action: "released-group" }));
}

function blockedReconciliation(database, records, error, execute) {
  const detail = error instanceof Error ? error.message : String(error);
  return records.map((record) => {
    if (execute && record.state !== "creating" && !(error instanceof ResourceBusyError)) updateState(database, record, "blocked", detail);
    return {
      record,
      inspection: { classification: "blocked", reason: detail, processes: [], containers: [], systemdUnits: [] },
      action: "none",
    };
  });
}

function reconcileRecords(database, selected, options) {
  const results = [];
  const visited = new Set();
  let inspectedGroups = 0;
  let after = options.after ?? "";
  for (const selectedRecord of selected) {
    if (visited.has(selectedRecord.id)) continue;
    const records = recordsInGroup(database, selectedRecord);
    records.forEach((record) => visited.add(record.id));
    if (inspectedGroups >= (options.maxGroups ?? Infinity) || Date.now() >= (options.deadline ?? Infinity)) {
      results.push(...records.map((record) => ({
        record,
        inspection: { classification: "deferred", reason: `inspection budget reached; not inspected; resume with --after ${after || "start"}`, processes: [], containers: [], systemdUnits: [] },
        action: "none",
        continuationAfter: after || "start",
      })));
      continue;
    }
    inspectedGroups += 1;
    if (records.some((record) => record.state === "creating")) {
      results.push(...records.map((record) => ({ record, inspection: {
        classification: "blocked", reason: "workspace creation is pending; repeat its original create command",
        processes: [], containers: [], systemdUnits: [],
      }, action: "none" })));
      after = selectedRecord.id;
      options.onProgress?.(after);
      continue;
    }
    try {
      results.push(...withWorkspaceLock(database, selectedRecord.path, () => {
        const current = recordsInGroup(database, recordBy(database, { id: selectedRecord.id }));
        const maintenance = duringInspection(options.deadline, () => new Map(current.map((record) => [record.id, maintainReferenceClone(record.path, options.execute)])));
        const reconciled = current.length > 1 ? groupReconciliation(database, current, options)
          : current.length === 1 ? [reconcileRecord(database, current[0], options)] : [];
        return reconciled.map((result) => ({ ...result, gitMaintenance: maintenance.get(result.record.id) }));
      }, selectedRecord.groupId, options.deadline));
    } catch (error) {
      results.push(...blockedReconciliation(database, records, error, error instanceof ResourceBusyError ? false : options.execute));
    }
    after = selectedRecord.id;
    options.onProgress?.(after);
  }
  return results;
}

function print(value, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const items = Array.isArray(value) ? value : [value];
  if (items.every((item) => item?.record !== undefined && item?.inspection !== undefined)) {
    for (const item of items) {
      process.stdout.write(`${item.record.id}\t${item.inspection.classification}\t${item.record.path}\t${item.action}\t${item.inspection.reason}\n`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) process.stdout.write(`${item.id}\t${item.state}\t${item.path}\t${item.detail}\n`);
    return;
  }
  process.stdout.write(`${value.path ?? value.id}\n`);
}

function registerCommand(database, args) {
  assertOnly(args, ["path", "root", "kind", "mode", "owner", "group", "source-commit", "lease-seconds", "cache", "cache-owned", "replace-cache", "json"]);
  const mode = one(args, "mode", "writer");
  if (!["writer", "review"].includes(mode)) fail("--mode must be writer or review");
  const selectedPath = path.resolve(required(args, "path"));
  const record = register(database, {
    path: selectedPath,
    root: one(args, "root"),
    kind: one(args, "kind", "agent"),
    mode,
    owner: one(args, "owner", "unowned"),
    groupId: one(args, "group"),
    sourceCommit: one(args, "source-commit"),
    leaseSeconds: numberFlag(args, "lease-seconds", DEFAULT_LEASE_SECONDS),
    cachePaths: cachePathsForRepository(selectedPath, args),
    replaceCachePaths: bool(args, "replace-cache"),
  });
  print(record, bool(args, "json"));
}

function gitRoot(candidate) {
  const probe = command("git", ["-C", candidate, "rev-parse", "--show-toplevel"]);
  return probe.status === 0 && path.resolve(probe.stdout) === candidate;
}

function adoptedGroupId(container) {
  return `adopted-${createHash("sha256").update(container).digest("hex").slice(0, 20)}`;
}

function directNestedGitRoots(container) {
  let entries;
  try { entries = readdirSync(container, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(container, entry.name))
    .filter((candidate) => existsSync(path.join(candidate, ".git")) && gitRoot(candidate));
}

function adoptionCandidates(root, nestedGroups) {
  const candidates = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(root, entry.name);
    if (!existsSync(candidate)) continue;
    const candidateIsGitRoot = gitRoot(candidate);
    if (!nestedGroups) {
      if (candidateIsGitRoot) candidates.push({ path: candidate, groupId: null });
      continue;
    }
    const nested = directNestedGitRoots(candidate);
    if (candidateIsGitRoot && nested.length === 0) {
      candidates.push({ path: candidate, groupId: null });
      continue;
    }
    const groupId = adoptedGroupId(candidate);
    if (candidateIsGitRoot) candidates.push({ path: candidate, groupId });
    candidates.push(...nested.map((nestedPath) => ({ path: nestedPath, groupId })));
  }
  return candidates;
}

function withAdoptionLocks(database, candidates, action, index = 0) {
  if (index >= candidates.length) return action();
  const candidate = candidates[index];
  return withWorkspaceLock(
    database,
    candidate.path,
    () => withAdoptionLocks(database, candidates, action, index + 1),
    candidate.groupId,
  );
}

function adoptCommand(database, args, statePath) {
  assertOnly(args, ["root", "kind", "mode", "owner", "group", "nested-groups", "lease-seconds", "cache", "cache-owned", "replace-cache", "execute", "reap-expired", "json"]);
  const root = path.resolve(required(args, "root"));
  const mode = one(args, "mode", "writer");
  if (!["writer", "review"].includes(mode)) fail("--mode must be writer or review");
  if (!existsSync(root)) fail(`root does not exist: ${root}`);
  const records = [];
  const requestedGroup = one(args, "group");
  const candidates = adoptionCandidates(root, bool(args, "nested-groups"));
  const desiredGroups = candidates.map((candidate) => requestedGroup ?? candidate.groupId);
  const existingCandidates = candidates.map((candidate) =>
    database.prepare("SELECT group_id, state, lease_expires_at FROM workspace WHERE path = ?").get(path.resolve(candidate.path)));
  const inheritedGroupLeases = new Map();
  candidates.forEach((candidate, index) => {
    const existing = existingCandidates[index];
    const desired = desiredGroups[index];
    if (existing !== undefined && existing.state !== "released" && desired !== null
      && existing.group_id !== null && existing.group_id !== desired) {
      fail(`workspace ${path.resolve(candidate.path)} already belongs to group ${existing.group_id}; requested ${desired}`);
    }
    if (existing !== undefined && existing.state !== "released" && desired !== null) {
      inheritedGroupLeases.set(desired, Math.max(inheritedGroupLeases.get(desired) ?? 0, existing.lease_expires_at));
    }
  });
  const registrations = candidates.map((candidate, index) => ({
    path: candidate.path,
    root,
    kind: one(args, "kind", "agent"),
    mode,
    owner: one(args, "owner", "unowned"),
    groupId: desiredGroups[index],
    sourceCommit: null,
    leaseSeconds: numberFlag(args, "lease-seconds", 0),
    leaseExpiresAt: desiredGroups[index] === null ? undefined : inheritedGroupLeases.get(desiredGroups[index]),
    replaceCachePaths: bool(args, "replace-cache"),
  }));
  withAdoptionLocks(database, registrations, () => {
    const prepared = registrations
      .filter((registration) => existsSync(registration.path) && gitRoot(registration.path))
      .map((registration) => ({
        ...registration,
        cachePaths: cachePathsForRepository(registration.path, args),
        inspection: registrationInspection(registration.path),
      }));
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const { inspection, ...registration } of prepared) {
        records.push(registerWorkspace(database, registration, inspection));
      }
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  });
  const execute = bool(args, "execute");
  const safety = execute ? safetySnapshot(database) : undefined;
  const results = execute
    ? reconcileRecords(database, records, { execute, reapExpired: bool(args, "reap-expired"), ignoreLease: false, statePath, safety })
    : records;
  print(results, bool(args, "json"));
}

function assertCapacity(root, args, database, reservedPath) {
  mkdirSync(root, { recursive: true });
  const pending = database?.prepare("SELECT path FROM workspace WHERE root=? AND state='creating'").all(root) ?? [];
  const count = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && path.join(root, entry.name) !== reservedPath).length +
    pending.filter((record) => record.path !== reservedPath && !existsSync(record.path)).length;
  const maxCount = numberFlag(args, "max-count", DEFAULT_MAX_COUNT);
  if (maxCount > 0 && count >= maxCount) fail(`workspace root has ${count} checkouts; limit is ${maxCount}. Reconcile it before creating another.`);
  const stats = statfsSync(root);
  const freeGiB = stats.bavail * stats.bsize / 1024 ** 3;
  const minFreeGiB = numberFlag(args, "min-free-gib", DEFAULT_MIN_FREE_GIB);
  if (freeGiB < minFreeGiB) fail(`${freeGiB.toFixed(2)} GiB is free; ${minFreeGiB.toFixed(2)} GiB is required`);
  const freeInodes = stats.files > 0 ? 100 * stats.ffree / stats.files : 100;
  const minFreeInodes = numberFlag(args, "min-free-inodes-percent", DEFAULT_MIN_FREE_INODES_PERCENT);
  if (freeInodes < minFreeInodes) fail(`${freeInodes.toFixed(2)}% of inodes are free; ${minFreeInodes.toFixed(2)}% is required`);
}

function safeName(value) {
  const result = value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 100);
  if (result.length === 0) fail("workspace name is empty after normalization");
  return result;
}

function mirrorFor(statePath, repository) {
  const digest = createHash("sha256").update(repository).digest("hex").slice(0, 24);
  return path.join(path.dirname(statePath), "mirrors", `${digest}.git`);
}

function repositoryLocation(value, directory) {
  if (path.isAbsolute(value) || /^[^/\s]+:/u.test(value)) return value;
  if (directory === undefined) {
    fail("the current directory was removed; --repo must be an absolute path or a Git URL");
  }
  return path.resolve(directory, value);
}

function repositoryRemotes(repository) {
  if (!existsSync(repository)) return { fetch: repository, push: repository };
  const valid = command("git", ["-C", repository, "rev-parse", "--git-dir"]);
  if (valid.status !== 0) return { fetch: repository, push: repository };
  const fetch = command("git", ["-C", repository, "remote", "get-url", "origin"]);
  if (fetch.status !== 0 || fetch.stdout.length === 0) return { fetch: repository, push: repository };
  const push = command("git", ["-C", repository, "remote", "get-url", "--push", "origin"]);
  const directory = realpathSync(repository);
  return {
    fetch: repositoryLocation(fetch.stdout, directory),
    push: repositoryLocation(push.status === 0 && push.stdout.length > 0 ? push.stdout : fetch.stdout, directory),
  };
}

// An explicit push URL disables Git's `url.<base>.pushInsteadOf` rewriting for the remote, so a
// checkout only records one when the source really pushes somewhere other than it fetches. A
// programme checkout cloned from a read-only URL then still pushes through the host's rewrite.
function configurePushUrl(gitArgs, upstream) {
  if (upstream.push !== upstream.fetch) {
    run("git", [...gitArgs, "remote", "set-url", "--push", "origin", upstream.push]);
  } else if (command("git", [...gitArgs, "config", "--get", "remote.origin.pushurl"]).status === 0) {
    run("git", [...gitArgs, "config", "--unset-all", "remote.origin.pushurl"]);
  }
}

const heldResourceLocks = new Map();

function withWorkspaceLock(database, workspacePath, action, requestedGroupId, deadline) {
  const statePath = registryPaths.get(database);
  const resolved = path.resolve(workspacePath);
  const existing = database.prepare("SELECT group_id, state FROM workspace WHERE path = ?").get(resolved);
  const groupId = existing?.state !== "released" ? existing?.group_id ?? requestedGroupId : requestedGroupId;
  const checkout = () => withResourceLock(statePath, `checkout:${resolved}`, action, deadline);
  return groupId ? withResourceLock(statePath, `group:${groupId}`, checkout, deadline) : checkout();
}

function withResourceLock(statePath, key, action, deadline) {
  const identity = `${statePath}\0${key}`;
  if (heldResourceLocks.has(identity)) return action();
  const directory = path.join(path.dirname(statePath), "locks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, createHash("sha256").update(key).digest("hex"));
  const descriptor = openSync(file, "a", 0o600);
  try {
    const waitMs = deadline === undefined ? 30_000 : Math.max(0, Math.min(100, deadline - Date.now()));
    const result = spawnSync("flock", ["--exclusive", "--wait", String(waitMs / 1000), "3"], {
      stdio: ["ignore", "pipe", "pipe", descriptor], encoding: "utf8", timeout: waitMs + 1000,
    });
    if (result.status !== 0) throw new ResourceBusyError(`workspace resource busy: ${key}: ${result.error?.message || result.stderr?.trim() || `${waitMs}ms lock budget exhausted`}`);
    heldResourceLocks.set(identity, descriptor);
    return action();
  } finally {
    heldResourceLocks.delete(identity);
    closeSync(descriptor);
  }
}

function sourceRefFor(repository, ref) {
  return `refs/pi-workspace/sources/${createHash("sha256").update(`${repository}\0${ref}`).digest("hex")}`;
}

function cachedImmutableSource(mirror, repository, ref) {
  if (!/^[0-9a-f]{40}$/u.test(ref) || !existsSync(mirror)) return null;
  const cached = command("git", ["--git-dir", mirror, "rev-parse", "--verify", `${sourceRefFor(repository, ref)}^{commit}`]);
  return cached.status === 0 && cached.stdout === ref ? ref : null;
}

function resolveSource(statePath, mirror, repository, upstream, ref) {
  const cached = cachedImmutableSource(mirror, repository, ref);
  if (cached !== null) return cached;
  return withResourceLock(statePath, `mirror:${mirror}`, () => {
    const shared = cachedImmutableSource(mirror, repository, ref);
    if (shared !== null) return shared;
    prepareMirror(mirror, repository, upstream);
    return fetchSource(mirror, repository, ref);
  });
}

function prepareMirror(mirror, repository, upstream) {
  mkdirSync(path.dirname(mirror), { recursive: true, mode: 0o700 });
  if (!existsSync(mirror)) run("git", ["init", "--bare", mirror]);
  for (const [name, url] of [["origin", upstream.fetch], ["workspace-source", repository]]) {
    const existing = command("git", ["--git-dir", mirror, "remote", "get-url", name]);
    if (existing.status !== 0 && existing.status !== 2) {
      fail(`cannot read mirror remote ${name}: ${existing.stderr || existing.error?.message || `exit ${existing.status}`}`);
    }
    run("git", ["--git-dir", mirror, "remote", existing.status === 0 ? "set-url" : "add", name, url]);
  }
  configurePushUrl(["--git-dir", mirror], upstream);
  run("git", ["--git-dir", mirror, "config", "remote.origin.mirror", "false"]);
  run("git", [
    "--git-dir", mirror, "config", "--replace-all", "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/*",
  ]);
  run("git", ["--git-dir", mirror, "fetch", "--prune", "--no-tags", "origin"], { timeout: 120_000 });
}

function fetchSource(mirror, repository, ref) {
  let resolved = ref;
  if (/^[0-9a-f]{4,39}$/u.test(ref)) {
    const source = existsSync(repository) ? ["-C", repository] : ["--git-dir", mirror];
    const commit = command("git", [...source, "rev-parse", "--verify", `${ref}^{commit}`]);
    if (commit.status !== 0) fail(`cannot resolve abbreviated source ${ref}; provide an unambiguous full commit or remote ref: ${commit.stderr}`);
    resolved = commit.stdout;
  }
  const sourceRef = sourceRefFor(repository, ref);
  run("git", ["--git-dir", mirror, "fetch", "--no-tags", "workspace-source", `+${resolved}:${sourceRef}`], { timeout: 120_000 });
  return run("git", ["--git-dir", mirror, "rev-parse", "--verify", `${sourceRef}^{commit}`]);
}

function createCommand(database, args, statePath) {
  const destination = path.join(path.resolve(required(args, "root")), safeName(required(args, "name")));
  return withWorkspaceLock(database, destination, () => createWorkspace(database, args, statePath), one(args, "group"));
}

function createWorkspace(database, args, statePath) {
  assertOnly(args, ["root", "name", "repo", "ref", "branch", "kind", "mode", "owner", "group", "strategy", "lease-seconds", "cache", "max-count", "min-free-gib", "min-free-inodes-percent", "json"]);
  const root = path.resolve(required(args, "root"));
  const name = safeName(required(args, "name"));
  const destination = path.join(root, name);
  const repository = repositoryLocation(required(args, "repo"), currentDirectory());
  const ref = one(args, "ref", "HEAD");
  const mode = one(args, "mode", "writer");
  if (!["writer", "review"].includes(mode)) fail("--mode must be writer or review");
  const strategy = one(args, "strategy", "clone");
  if (!["clone", "worktree"].includes(strategy)) fail("--strategy must be clone or worktree");
  const branch = one(args, "branch", `agent/${name}`);
  const request = JSON.stringify({ repository, ref, mode, strategy, branch,
    owner: one(args, "owner", name), kind: one(args, "kind", "agent"), groupId: one(args, "group", null),
    cachePaths: normalizeCachePaths(many(args, "cache")),
    leaseSeconds: numberFlag(args, "lease-seconds", DEFAULT_LEASE_SECONDS) });
  const input = JSON.parse(request);
  const mirror = mirrorFor(statePath, repository);
  const upstream = repositoryRemotes(repository);
  let row = database.prepare("SELECT * FROM workspace WHERE path = ?").get(destination);
  if (row !== undefined && row.state !== "released") {
    if (row.creation_request !== request) fail(`workspace already exists with a different creation request: ${destination}${row.state === "creating" ? "; resume the original request, or use cancel-creation if its destination is absent" : ""}`);
    if (row.state === "active" && existsSync(destination)) {
      print(rowToRecord(row), bool(args, "json"));
      return;
    }
    if (row.state !== "creating") fail(`workspace cannot resume creation from state ${row.state}: ${destination}`);
  } else {
    if (existsSync(destination)) fail(`workspace already exists: ${destination}`);
    assertCapacity(root, args, database);
    const sourceCommit = resolveSource(statePath, mirror, repository, upstream, ref);
    withResourceLock(statePath, `admission:${root}`, () => {
      assertCapacity(root, args, database);
      const now = Date.now();
      database.prepare(`INSERT INTO workspace
        (id,path,root,kind,mode,owner,repository,source_commit,checkout_type,cache_paths,
         created_at,updated_at,lease_expires_at,state,detail,group_id,creation_request)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'creating','creation reserved',?,?)
        ON CONFLICT(path) DO UPDATE SET id=excluded.id, kind=excluded.kind, mode=excluded.mode,
        owner=excluded.owner, repository=excluded.repository, source_commit=excluded.source_commit,
        checkout_type=excluded.checkout_type, cache_paths=excluded.cache_paths,
        created_at=excluded.created_at, updated_at=excluded.updated_at, lease_expires_at=excluded.lease_expires_at,
        state=excluded.state, detail=excluded.detail, group_id=excluded.group_id, creation_request=excluded.creation_request
        WHERE workspace.state='released'`).run(randomUUID(), destination, root, input.kind, mode,
        input.owner, repository, sourceCommit, strategy, JSON.stringify(input.cachePaths), now, now,
        now + input.leaseSeconds * 1000, input.groupId, request);
    });
    row = database.prepare("SELECT * FROM workspace WHERE path = ?").get(destination);
    if (row.creation_request !== request) fail(`workspace creation was claimed by another request: ${destination}`);
  }
  let sourceCommit = row.source_commit;
  if (sourceCommit === null) {
    sourceCommit = resolveSource(statePath, mirror, repository, upstream, ref);
    database.prepare("UPDATE workspace SET source_commit=?, updated_at=? WHERE id=?")
      .run(sourceCommit, Date.now(), row.id);
  }
  try {
    if (!existsSync(destination) || readdirSync(destination).length === 0) {
      assertCapacity(root, args, database, destination);
      if (strategy === "worktree") {
        const worktreeArgs = ["--git-dir", mirror, "worktree", "add"];
        if (mode === "review") worktreeArgs.push("--detach", destination, sourceCommit);
        else worktreeArgs.push("-b", branch, destination, sourceCommit);
        run("git", worktreeArgs);
      } else {
        run("git", ["clone", "--no-local", ...Object.entries(REFERENCE_CLONE_CONFIG)
          .flatMap(([name, value]) => ["--config", `${name}=${value}`]),
          "--reference-if-able", mirror, "--no-checkout", repository, destination], { timeout: 40_000 });
      }
    }
    const info = gitInfo(destination);
    if (info.checkoutType !== strategy) fail("pending checkout type changed");
    if (strategy === "clone") {
      const entries = readdirSync(destination).filter((entry) => entry !== ".git");
      if (entries.length === 0 && !existsSync(path.join(destination, ".git", "index"))) {
        if (mode === "review") git(destination, ["checkout", "--detach", sourceCommit]);
        else {
          const existing = command("git", ["-C", destination, "rev-parse", "--verify", `refs/heads/${branch}`]);
          if (existing.status === 0 && existing.stdout !== sourceCommit) fail("pending checkout branch has different source");
          git(destination, existing.status === 0 ? ["checkout", branch] : ["checkout", "-b", branch, sourceCommit]);
        }
      }
    }
    const head = git(destination, ["rev-parse", "HEAD"]);
    const selectedBranch = command("git", ["-C", destination, "symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (head !== sourceCommit || (mode === "writer" ? selectedBranch.stdout !== branch : selectedBranch.status === 0)) {
      fail("pending checkout HEAD or branch differs from the reserved source");
    }
    if (git(destination, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"])) {
      fail("pending checkout contains changes; preserve and repair them before resuming creation");
    }
    if (strategy === "clone") {
      git(destination, ["remote", "set-url", "origin", upstream.fetch]);
      configurePushUrl(["-C", destination], upstream);
      maintainReferenceClone(destination, true);
    }
    const now = Date.now();
    database.prepare("UPDATE workspace SET repository=?, state='active', detail='creation completed', updated_at=?, lease_expires_at=? WHERE id=?")
      .run(upstream.fetch, now, now + input.leaseSeconds * 1000, row.id);
    print(recordBy(database, { id: row.id }), bool(args, "json"));
  } catch (error) {
    database.prepare("UPDATE workspace SET detail=?, updated_at=? WHERE id=? AND state='creating'")
      .run(`creation retained: ${error.message}`, Date.now(), row.id);
    throw error;
  }
}

function cancelCreationCommand(database, args) {
  assertOnly(args, ["id", "path", "json"]);
  const record = recordBy(database, selectorFrom(args));
  if (record.state !== "creating") fail(`workspace cannot cancel creation from state ${record.state}`);
  // lstat also protects dangling symlinks. Cancellation never removes filesystem entries.
  try {
    lstatSync(record.path);
    fail(`pending checkout exists; repeat the original create command to resume and preserve its source: ${record.path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  database.prepare("UPDATE workspace SET state='released', lease_expires_at=0, updated_at=?, detail='creation cancelled; destination absent' WHERE id=? AND state='creating'")
    .run(Date.now(), record.id);
  print(recordBy(database, { id: record.id }), bool(args, "json"));
}

function heartbeatCommand(database, args) {
  assertOnly(args, ["id", "path", "lease-seconds", "json"]);
  const record = recordBy(database, selectorFrom(args));
  if (["released", "reclaiming", "creating"].includes(record.state)) fail(`workspace cannot renew from state ${record.state}`);
  if (!existsSync(record.path)) fail(`workspace path is absent: ${record.path}`);
  const now = Date.now();
  const expires = now + numberFlag(args, "lease-seconds", DEFAULT_LEASE_SECONDS) * 1000;
  const records = recordsInGroup(database, record);
  if (records.some((candidate) => candidate.state === "creating")) fail("workspace group has a pending creation; resume it before renewal");
  const statement = database.prepare("UPDATE workspace SET lease_expires_at = ?, updated_at = ?, state = 'active', detail = 'lease renewed' WHERE id = ?");
  for (const candidate of records) statement.run(expires, now, candidate.id);
  const renewed = records.map((candidate) => recordBy(database, { id: candidate.id }));
  print(renewed.length === 1 ? renewed[0] : renewed, bool(args, "json"));
}

function releaseCommand(database, args, statePath) {
  assertOnly(args, ["id", "path", "reap-expired", "json"]);
  const record = recordBy(database, selectorFrom(args));
  const records = recordsInGroup(database, record);
  const statement = database.prepare("UPDATE workspace SET lease_expires_at = 0, updated_at = ?, detail = 'owner released lease' WHERE id = ?");
  const updatedAt = Date.now();
  for (const candidate of records) statement.run(updatedAt, candidate.id);
  const current = records.map((candidate) => recordBy(database, { id: candidate.id }));
  const result = reconcileRecords(database, current, {
    execute: true,
    reapExpired: bool(args, "reap-expired"),
    ignoreLease: true,
    statePath,
    safety: safetySnapshot(database),
  });
  print(result.length === 1 ? result[0] : result, bool(args, "json"));
}

// A released workspace whose tree is gone is history, not state. Keep a month
// of it for questions like "what happened to that checkout" and no more; a
// busy fleet registers thousands of checkouts and each one used to stay forever.
const RELEASED_RETENTION_MS = 30 * 24 * 60 * 60_000;
function pruneReleased(database, now = Date.now()) {
  const stale = database.prepare("SELECT id, path FROM workspace WHERE state = 'released' AND updated_at < ?").all(now - RELEASED_RETENTION_MS);
  const remove = database.prepare("DELETE FROM workspace WHERE id = ?");
  let pruned = 0;
  for (const row of stale) {
    if (existsSync(row.path)) continue;
    remove.run(row.id);
    pruned += 1;
  }
  return pruned;
}

function reconcileCommand(database, args, statePath) {
  assertOnly(args, ["root", "id", "path", "execute", "reap-expired", "ignore-lease", "json", "max-groups", "budget-ms", "after"]);
  const started = Date.now();
  const budget = numberFlag(args, "budget-ms", 20_000);
  const maxGroups = numberFlag(args, "max-groups", 32);
  if (budget < 1 || budget > 40_000) fail("--budget-ms must be between 1 and 40000");
  if (!Number.isSafeInteger(maxGroups) || maxGroups < 1) fail("--max-groups must be a positive integer");
  const execute = bool(args, "execute");
  if (execute) pruneReleased(database);
  let records;
  if (one(args, "id") !== undefined || one(args, "path") !== undefined) records = [recordBy(database, selectorFrom(args))];
  else records = listRecords(database, one(args, "root"));
  records = records.filter((record) => record.state !== "released" || existsSync(record.path));
  const scope = one(args, "root") === undefined ? "*" : path.resolve(one(args, "root"));
  const targeted = one(args, "id") !== undefined || one(args, "path") !== undefined;
  database.exec("CREATE TABLE IF NOT EXISTS reconciliation_cursor (scope TEXT PRIMARY KEY, after_id TEXT NOT NULL)");
  const saved = execute && !targeted ? database.prepare("SELECT after_id FROM reconciliation_cursor WHERE scope = ?").get(scope)?.after_id : undefined;
  const after = one(args, "after", saved ?? "start");
  const anchor = after === "start" ? undefined : database.prepare("SELECT root, path FROM workspace WHERE id = ?").get(after);
  if ((!anchor || (scope !== "*" && anchor.root !== scope)) && after !== "start" && one(args, "after") !== undefined) fail(`--after workspace is not in the selected pool: ${after}`);
  if (anchor) {
    const pivot = records.findIndex((record) => record.root > anchor.root || (record.root === anchor.root && record.path > anchor.path));
    if (pivot >= 0) records = [...records.slice(pivot), ...records.slice(0, pivot)];
  }
  const deadline = started + budget;
  let safety;
  try {
    safety = duringInspection(deadline, () => safetySnapshot(database));
  } catch (error) {
    print(blockedReconciliation(database, records, error, false), bool(args, "json"));
    return;
  }
  const results = reconcileRecords(database, records, {
    execute,
    reapExpired: bool(args, "reap-expired"),
    ignoreLease: bool(args, "ignore-lease"),
    statePath,
    safety,
    deadline,
    maxGroups,
    after,
    onProgress: execute && !targeted ? (id) => database.prepare(
      "INSERT INTO reconciliation_cursor (scope, after_id) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET after_id = excluded.after_id",
    ).run(scope, id) : undefined,
  });
  print(results, bool(args, "json"));
}

function maintainCommand(database, args) {
  assertOnly(args, ["root", "id", "path", "execute", "json"]);
  const records = one(args, "id") !== undefined || one(args, "path") !== undefined
    ? [recordBy(database, selectorFrom(args))] : listRecords(database, one(args, "root"));
  const results = [];
  for (const record of records) {
    try {
      const result = withWorkspaceLock(database, record.path, () => maintainReferenceClone(record.path, bool(args, "execute")), record.groupId);
      if (result) results.push(result);
    } catch (error) {
      results.push({ path: record.path, error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    }
  }
  if (bool(args, "json")) print(results, true);
  else for (const result of results) process.stdout.write(`${result.path}\t${result.error ?? `${result.settings.join(",") || "configured"}; gc.log ${result.gcLog}`}\n`);
}

function statusCommand(database, args) {
  assertOnly(args, ["root", "json", "path", "owner"]);
  const root = one(args, "root");
  const pathFilter = one(args, "path");
  const ownerFilter = one(args, "owner");
  const predicates = [];
  const parameters = [];
  if (root !== undefined) {
    predicates.push("root = ?");
    parameters.push(path.resolve(root));
  }
  if (pathFilter !== undefined) {
    predicates.push("(path = ? OR instr(path, ?) > 0)");
    parameters.push(path.resolve(pathFilter), pathFilter);
  }
  if (ownerFilter !== undefined) {
    predicates.push("instr(coalesce(owner, ''), ?) > 0");
    parameters.push(ownerFilter);
  }
  const where = predicates.length > 0 ? ` WHERE ${predicates.join(" AND ")}` : "";
  const records = database.prepare(`SELECT * FROM workspace${where} ORDER BY root, path`)
    .all(...parameters).map(rowToRecord);
  if (bool(args, "json")) {
    print(records, true);
    return;
  }
  const filtered = pathFilter !== undefined || ownerFilter !== undefined;
  const total = !filtered ? records.length : root === undefined
    ? database.prepare("SELECT count(*) AS count FROM workspace").get().count
    : database.prepare("SELECT count(*) AS count FROM workspace WHERE root = ?").get(path.resolve(root)).count;
  if (filtered && records.length === 0) {
    process.stdout.write(`no registered workspace matches that filter; ${total} record(s) are known, and a checkout absent from all of them was never registered\n`);
    return;
  }
  const summary = new Map();
  for (const record of records) summary.set(record.state, (summary.get(record.state) ?? 0) + 1);
  const scope = filtered ? ` (filtered from ${total})` : "";
  process.stdout.write(`${records.length} registered workspace(s)${scope}: ${[...summary].map(([state, count]) => `${state}=${count}`).join(" ")}\n`);
  if (filtered) {
    for (const record of records) {
      process.stdout.write(`${record.path}\n  state ${record.state}: ${record.detail}\n  owner ${record.owner ?? "(none)"}  mode ${record.mode}  present-on-disk ${existsSync(record.path)}\n`);
    }
    return;
  }
  print(records, false);
}

function help() {
  process.stdout.write(`Usage:
  agent-workspace create --root PATH --name NAME --repo URL [--ref GIT_REF] [--mode writer|review] [--group ID] [--cache PATH,...]
  agent-workspace register --path PATH [--owner ID] [--source-commit SHA] [--group ID] [--cache PATH,...] [--cache-owned OUTPUT=TRACKED_SOURCE] [--replace-cache]
  agent-workspace adopt --root PATH [--mode writer|review] [--nested-groups] [--cache PATH,...] [--cache-owned OUTPUT=TRACKED_SOURCE] [--replace-cache] [--execute]
  agent-workspace cancel-creation (--id ID|--path PATH)
  agent-workspace heartbeat (--id ID|--path PATH) [--lease-seconds N]
  agent-workspace release (--id ID|--path PATH) [--reap-expired]
  agent-workspace reconcile [--root PATH] [--execute] [--reap-expired]
                            [--budget-ms 20000] [--max-groups 32] [--after ID|start]
  agent-workspace maintain [--root PATH | --path PATH] [--execute] [--json]
  agent-workspace status [--root PATH] [--path SUBSTRING] [--owner SUBSTRING] [--json]
  agent-workspace list ...                    alias for status

The registry defaults to ${DEFAULT_STATE}. Set PI_WORKSPACE_STATE to move it.
Repeat --cache to declare ignored generated paths that release may remove; these extend the default cache set.
Use a Git ref the source repository can fetch, such as refs/heads/main or a branch name, not origin/main.
A lease expiry permits reconciliation; it never makes dirty or unpushed work disposable.
Records with the same --group lease, heartbeat, and release as one multi-repository workspace.
Records outlive the directory, so status explains what became of a checkout that is gone;
--path takes a substring, so "status --path ob50" answers that without reading every record.
`);
}

export const workspaceTesting = { cacheTargets, dockerEndpointScope, dockerSnapshot, groupReconciliation, maintainReferenceClone, parseSystemdUnits, pruneReleased, systemdManagerSnapshot, systemdReferences };

export function main(argv = process.argv.slice(2), statePath = DEFAULT_STATE) {
  const [commandName, ...rest] = argv;
  if (
    commandName === undefined ||
    commandName === "--help" ||
    commandName === "help" ||
    (rest.length === 1 && rest[0] === "--help")
  ) {
    help();
    return;
  }
  const args = parseArgs(rest);
  if (args.positional.length > 0) fail(`unexpected argument: ${args.positional[0]}`);
  if (commandName === "create") {
    const repository = repositoryLocation(required(args, "repo"), currentDirectory());
    if (process.env.PI_WORKSPACE_CREATE_CHILD !== statePath) {
      args.named.set("root", [path.resolve(required(args, "root"))]);
      args.named.set("repo", [repository]);
      const normalized = [...args.named].flatMap(([name, values]) => values.map((value) => `--${name}=${value}`));
      const result = command("timeout", ["--kill-after=1", "45",
        process.execPath, new URL(import.meta.url).pathname, "create", ...normalized], {
        timeout: 48_000,
        env: { PI_WORKSPACE_STATE: statePath, PI_WORKSPACE_CREATE_CHILD: statePath },
      });
      if (result.status === 75) throw new ResourceBusyError(result.stderr);
      if (result.status !== 0) fail(result.stderr || result.error?.message ||
        "creation interrupted; repeat the same command to resume");
      process.stdout.write(`${result.stdout}\n`);
      return;
    }
  }
  if (!["status", "list", "maintain", "cancel-creation"].includes(commandName)
    && (commandName !== "reconcile" || bool(args, "execute"))) drainGc(statePath);
  const database = openRegistry(statePath);
  try {
    if (commandName === "create") createCommand(database, args, statePath);
    else if (commandName === "register") registerCommand(database, args);
    else if (commandName === "adopt") adoptCommand(database, args, statePath);
    else if (["heartbeat", "release", "cancel-creation"].includes(commandName)) {
      const record = recordBy(database, selectorFrom(args));
      withWorkspaceLock(database, record.path, () => {
        if (commandName === "heartbeat") heartbeatCommand(database, args);
        else if (commandName === "cancel-creation") cancelCreationCommand(database, args);
        else releaseCommand(database, args, statePath);
      }, record.groupId);
    }
    else if (commandName === "reconcile") reconcileCommand(database, args, statePath);
    else if (commandName === "maintain") maintainCommand(database, args);
    else if (commandName === "status" || commandName === "list") statusCommand(database, args);
    else {
      help();
      fail(`unknown command: ${commandName}`);
    }
  } finally {
    database.close();
  }
}

if (process.argv[1] !== undefined && existsSync(process.argv[1])
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error) => {
      if (error.code === "EPIPE") process.exit(0);
      throw error;
    });
  }
  try {
    main();
  } catch (error) {
    process.stderr.write(`agent-workspace: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(error instanceof ResourceBusyError ? 75 : error instanceof CliError ? 2 : 1);
  }
}
