#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  closeSync,
  existsSync,
  openSync,
  opendirSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { runSourceJob, readSourceJobRequest, writeSourceJobProgress, finishSourceJob, sourceJobId } from "./source-job.mjs";
import { capacityRecovery } from "./capacity-recovery.mjs";
import { retireSourceMaterialization, validateMaterializationRequest, MaterializationError } from "./source-materialization.mjs";
import { jobObserveCommand, observeWorkspaceJob } from "./job-observation.mjs";
import { GrowthLifecycleError, digest, growthError, retainedGrowth, validateRetirement, validateReduction } from "./growth-lifecycle.mjs";

class SourcePreparationRequired extends Error {}
let sourcePreparationMode = null;
let sourcePreparationDeadline = Infinity;
let sourceJobDirectory = null;

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
  ".gradle",
  "**/.gradle",
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
const DEFAULT_CREATION_TIMEOUT_SECONDS = 300;
const ORIGIN_FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

function creationTimeout(args) {
  const seconds = numberFlag(args, "creation-timeout-seconds", DEFAULT_CREATION_TIMEOUT_SECONDS);
  if (seconds < 1 || seconds > 86400) fail("--creation-timeout-seconds must be between 1 and 86400");
  return seconds * 1000;
}

class CliError extends Error {}
class ResourceBusyError extends CliError {}
class RegistrationMismatchError extends CliError {
  constructor(field, requested, recorded) {
    super(`registration metadata mismatch for ${field}: requested ${requested}, recorded ${recorded}; use reassign for an authorized owner/source handoff`);
    this.code = "registration-metadata-mismatch";
    this.field = field;
    this.requested = requested;
    this.recorded = recorded;
  }
}

let inspectionDeadline;
let creationDeadline;
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
  const remaining = Math.min(inspectionDeadline ?? Infinity, creationDeadline ?? Infinity, sourcePreparationDeadline) - Date.now();
  if (sourcePreparationMode === "foreground" && remaining <= 0) throw new SourcePreparationRequired();
  if (remaining <= 0) fail(creationDeadline === undefined
    ? "workspace inspection budget exhausted; no safety verdict was established"
    : "creation budget exhausted; checkout retained; repeat the same create command to resume");
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
  if (sourcePreparationMode === "foreground" && result.error?.code === "ETIMEDOUT") throw new SourcePreparationRequired();
  if (inspectionDeadline !== undefined && result.error?.code === "ETIMEDOUT") {
    fail(`workspace inspection timed out: ${executable} ${commandArgs.join(" ")}; no safety verdict was established`);
  }
  if (creationDeadline !== undefined && result.error?.code === "ETIMEDOUT") {
    fail("creation command timed out; repeat the same create command to retry, optionally increasing --creation-timeout-seconds (maximum 86400)");
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

function hasPendingIndex(database) {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='workspace_pending'").get() !== undefined;
}

function registrySchemaVersion(database) {
  const version = database.prepare("PRAGMA user_version").get().user_version;
  if (version > REGISTRY_SCHEMA_VERSION) fail(`workspace registry schema ${version} needs a newer agent-workspace`);
  return version;
}

function hasCapacityLedger(database) {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_capacity'").get() !== undefined;
}

function hasCapacityMeasurements(database) {
  return database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('workspace_capacity_measurement','workspace_capacity_repricing')").get().count === 2;
}

function hasReassignmentLedger(database) {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_reassignment'").get() !== undefined;
}

const ASSIGNMENT_SOURCE = `(SELECT new_source_commit FROM workspace_reassignment
  WHERE workspace_id = workspace.id ORDER BY sequence DESC LIMIT 1) AS assignment_source_commit`;

function initializeRegistry(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS workspace_reassignment (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL, path TEXT NOT NULL,
    old_owner TEXT NOT NULL, old_source_commit TEXT,
    new_owner TEXT NOT NULL, new_source_commit TEXT NOT NULL,
    authorization TEXT NOT NULL, occurred_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS workspace_reassignment_record ON workspace_reassignment(workspace_id, sequence)`);
  database.exec(`CREATE TABLE IF NOT EXISTS workspace_capacity (
    workspace_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, plan_json TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS workspace_capacity_device ON workspace_capacity(device_id)`);
  database.exec(`CREATE TABLE IF NOT EXISTS workspace_capacity_measurement (
    workspace_id TEXT PRIMARY KEY, measurement_json TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS workspace_capacity_repricing (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, occurred_at INTEGER NOT NULL,
    old_plan_json TEXT NOT NULL, new_plan_json TEXT NOT NULL, measurement_json TEXT NOT NULL
  )`);
  if (database.prepare("PRAGMA journal_mode").get().journal_mode !== "wal") {
    database.exec("PRAGMA journal_mode = WAL");
  }
  if (registrySchemaVersion(database) === REGISTRY_SCHEMA_VERSION) {
    database.exec("CREATE INDEX IF NOT EXISTS workspace_pending ON workspace(root, path) WHERE state='creating'");
    return;
  }
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
      CREATE INDEX IF NOT EXISTS workspace_pending ON workspace(root, path) WHERE state='creating';
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
    if (registrySchemaVersion(database) !== REGISTRY_SCHEMA_VERSION || !hasPendingIndex(database) || !hasCapacityLedger(database) || !hasCapacityMeasurements(database) || !hasReassignmentLedger(database) ||
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
    sourceCommit: row.assignment_source_commit ?? row.source_commit,
    durableSourceCommit: row.source_commit,
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
    ? database.prepare(`SELECT workspace.*, ${ASSIGNMENT_SOURCE} FROM workspace WHERE id = ?`).get(selector.id)
    : database.prepare(`SELECT workspace.*, ${ASSIGNMENT_SOURCE} FROM workspace WHERE path = ?`).get(path.resolve(selector.path));
  if (row === undefined) fail(`workspace not registered: ${selector.id ?? selector.path}`);
  return rowToRecord(row);
}

function listRecords(database, root) {
  const rows = root === undefined
    ? database.prepare(`SELECT workspace.*, ${ASSIGNMENT_SOURCE} FROM workspace ORDER BY root, path`).all()
    : database.prepare(`SELECT workspace.*, ${ASSIGNMENT_SOURCE} FROM workspace WHERE root = ? ORDER BY path`).all(path.resolve(root));
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

function maintainReferenceClone(workspace, execute, statePath) {
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
  const objectCustody = stabilizeObjectCustody(workspace, alternates, execute, statePath);
  return { path: workspace, settings: settings.map(([name]) => name), gcLog, objectCustody };
}

function register(database, input) {
  return withWorkspaceLock(database, input.path, () => registerWorkspace(database, input), input.groupId);
}

function registrationInspection(workspace, statePath) {
  const info = gitInfo(workspace);
  maintainReferenceClone(workspace, true, statePath);
  return info;
}

function registerWorkspace(database, input, inspectedInfo) {
  const now = Date.now();
  const existing = database.prepare(`SELECT workspace.*, ${ASSIGNMENT_SOURCE} FROM workspace WHERE path = ?`).get(path.resolve(input.path));
  if (existing !== undefined && recordRetainsCustody(database, existing.id)) growthError("growth-admission-required", "retained custody cannot register/adopt until fresh resume-growth admission");
  if (existing !== undefined && existing.state !== "released") {
    const recorded = rowToRecord(existing);
    for (const [field, requested] of Object.entries(input.assertMetadata ?? {})) {
      if (recorded[field] !== requested) throw new RegistrationMismatchError(field, requested, recorded[field]);
    }
  }
  if (existing?.state === "creating") return rowToRecord(existing);
  if (retainedParent(database,input.path)) growthError("growth-admission-required", "shared Git parent growth is retired");
  const info = inspectedInfo ?? registrationInspection(input.path, registryPaths.get(database));
  if (existing !== undefined && existing.state !== "released") {
    if (input.groupId != null && existing.group_id !== null && existing.group_id !== input.groupId) {
      fail(`workspace ${path.resolve(input.path)} already belongs to group ${existing.group_id}; requested ${input.groupId}`);
    }
    const cachePaths = input.replaceCachePaths
      ? input.cachePaths
      : [...new Set([...JSON.parse(existing.cache_paths), ...input.cachePaths])];
    const groupId = input.groupId ?? existing.group_id;
    database.prepare("UPDATE workspace SET checkout_type = ?, cache_paths = ?, group_id = ?, updated_at = ? WHERE id = ?")
      .run(info.checkoutType, JSON.stringify(cachePaths), groupId, now, existing.id);
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
    durableSourceCommit: input.sourceCommit ?? null,
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

function processSnapshot(strict = false, workspacePath = null, fdAccess = "write") {
  if (!["write", "all"].includes(fdAccess)) growthError("growth-writer-unknown", "unknown FD observation mode");
  if (!existsSync("/proc")) { if (strict) growthError("growth-writer-unknown", "/proc unavailable"); return []; }
  const ignored = processAncestry();
  const uid = process.getuid?.();
  if (uid === undefined) { if (strict) growthError("growth-writer-unknown", "process identity unavailable"); return []; }
  const processes = [];
  let entries;
  try { entries = readdirSync("/proc"); } catch (error) { if (strict) throw error; return []; }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    if (ignored.has(pid)) continue;
    const root = `/proc/${pid}`;
    try {
      const status = readFileSync(`${root}/status`, "utf8");
      const owner = Number(status.match(/^Uid:\s+(\d+)/mu)?.[1]);
      if (strict && !Number.isSafeInteger(owner)) growthError("growth-writer-unknown", `unknown process owner ${pid}`);
      if (owner !== uid && !strict) continue;
      const commandLine = readFileSync(`${root}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (strict && readLink(`${root}/cwd`) === null && commandLine.length > 0) growthError("growth-writer-unknown", `unknown cwd for process ${pid}`);
      const writableFiles = [];
      const cwd = readLink(`${root}/cwd`), executable = readLink(`${root}/exe`);
      if (strict && commandLine.length > 0) {
        for (const fd of readdirSync(`${root}/fd`)) {
          let target;
          try { target = readlinkSync(`${root}/fd/${fd}`).replace(/ \(deleted\)$/u, ""); }
          catch (error) { if (error.code === "ENOENT") continue; throw error; }
          if (workspacePath && path.isAbsolute(target) && (Array.isArray(workspacePath) ? workspacePath : [workspacePath]).some(root => within(root, target))) {
            const flags = readFileSync(`${root}/fdinfo/${fd}`, "utf8").match(/^flags:\s+([0-7]+)$/mu)?.[1];
            if (flags === undefined) growthError("growth-writer-unknown", `unknown fd flags ${pid}/${fd}`);
            if (fdAccess === "all" || (parseInt(flags,8) & 3) !== 0) writableFiles.push(target);
          }
        }
      }
      processes.push({
        writableFiles,
        pid,
        command: commandLine[0] ?? "unknown",
        commandLine,
        cwd,
        executable,
      });
    } catch (error) {
      if (strict && (!["ENOENT", "ESRCH"].includes(error.code) || existsSync(root))) growthError("growth-writer-unknown", `cannot inspect process ${pid}: ${error.message}`);
      continue;
    }
  }
  return processes;
}

function processReferences(workspacePath, snapshot = processSnapshot()) {
  return snapshot.flatMap((processRecord) => {
    const matches = (processRecord.writableFiles ?? []).filter(file => within(workspacePath, file)).map(file => `write-fd:${file}`);
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
    "--output=json",
    "--no-pager",
  ], { timeout: 20_000 });
  if (listed.error?.code === "ENOENT" || /not been booted with systemd|failed to connect to (?:user scope )?bus|(?:DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR) not defined/iu.test(listed.stderr)) {
    return { units: [], available: false };
  }
  if (listed.status !== 0) return { units: [], available: true, error: listed.stderr || listed.stdout || "systemctl list-units failed" };
  let rows;
  try {
    rows = JSON.parse(listed.stdout);
  } catch {
    return { units: [], available: true, error: "systemctl list-units returned invalid JSON" };
  }
  if (!Array.isArray(rows) || rows.some((row) =>
    row === null || typeof row !== "object" || typeof row.unit !== "string" ||
    !/^[a-zA-Z0-9:_.@\\\\-]+\.(?:service|scope)$/u.test(row.unit))) {
    return { units: [], available: true, error: "systemctl list-units returned invalid unit records" };
  }
  const unitIds = rows.map((row) => row.unit);
  if (new Set(unitIds).size !== unitIds.length) {
    return { units: [], available: true, error: "systemctl list-units returned duplicate unit records" };
  }
  if (unitIds.length === 0) return { units: [], available: true };
  const shown = execute("systemctl", [
    ...managerArgs,
    "show",
    "--property=Id",
    "--property=ActiveState",
    "--property=WorkingDirectory",
    "--property=ExecStart",
    "--",
    ...unitIds,
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
  // Stream only topology; cache/creation JSON is large and irrelevant here.
  const rows = database.prepare("SELECT id,path,checkout_type AS checkoutType FROM workspace ORDER BY path,id").iterate();
  for (const record of rows) {
    if (inspectionDeadline !== undefined && Date.now() >= inspectionDeadline) growthError("growth-observation-timeout", "dependency observation budget exhausted");
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
    contents = readFileSync(alternatesPath, "utf8");
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

function optionalOwnerPath(candidate) {
  try { statSync(candidate); return true; }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function ownerThreadDatabases() {
  const databases = new Set();
  const fleetDir = path.dirname(process.env.PI_ORCHESTRATOR_LEDGER ??
    path.join(homedir(), ".local", "share", "pi-orchestrator", "ledger.sqlite3"));
  databases.add(path.join(fleetDir, "threads.sqlite3"));
  const applications = path.join(fleetDir, "applications");
  if (optionalOwnerPath(applications)) {
    for (const entry of readdirSync(applications, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) databases.add(path.join(applications, entry.name, "threads.sqlite3"));
    }
  }
  const owner = userInfo().username;
  const person = path.join("/var/lib/pi-remote/persons", `${owner}.json`);
  let remoteData = process.env.PI_REMOTE_DATA;
  if (!remoteData && optionalOwnerPath(person)) {
    const registration = JSON.parse(readFileSync(person, "utf8"));
    if (registration.user === owner) remoteData = registration.environment?.PI_REMOTE_DATA;
  }
  remoteData ??= path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"), "pi-remote");
  databases.add(path.join(remoteData, "threads.sqlite3"));
  if (process.env.PI_THREAD_DATABASE) databases.add(process.env.PI_THREAD_DATABASE);
  return [...databases];
}

function threadSnapshot(paths = ownerThreadDatabases()) {
  const references = [];
  for (const databasePath of paths) {
    if (!optionalOwnerPath(databasePath)) continue;
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      references.push(...database.prepare(`SELECT t.id, t.cwd FROM thread t WHERE t.state='running'
        OR json_extract(t.metadata,'$.agentWait') IS NOT NULL
        OR json_extract(t.metadata,'$.cancellationRequest') IS NOT NULL
        OR EXISTS(SELECT 1 FROM thread_work w WHERE w.thread_id=t.id AND w.status!='done')
        OR EXISTS(SELECT 1 FROM thread_execution e WHERE e.thread_id=t.id AND e.ended_at IS NULL)`)
        .all().map((row) => ({ id: row.id, cwd: row.cwd, database: databasePath })));
    } finally {
      database.close();
    }
  }
  return references;
}

function safetySnapshot(database) {
  const isolated = process.env.NODE_TEST_CONTEXT !== undefined &&
    process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY === "empty";
  const gitDependencies = gitDependencySnapshot(database);
  return {
    processes: isolated ? [] : processSnapshot(),
    docker: isolated ? { containers: [], available: false } : dockerSnapshot(),
    systemd: isolated ? { units: [], available: false } : systemdSnapshot(),
    threads: isolated && !process.env.PI_THREAD_DATABASE ? [] : threadSnapshot(),
    gitAlternates: gitDependencies.alternates,
    linkedWorktrees: gitDependencies.linkedWorktrees,
  };
}

function freshThreadSafety(safety) {
  if (process.env.NODE_TEST_CONTEXT !== undefined && process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY === "empty" &&
    !process.env.PI_THREAD_DATABASE) return safety;
  return { ...safety, threads: [...(safety?.threads ?? []), ...threadSnapshot()] };
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
  if (changed.length > 0) return { safe: false, sourceRetention: true, reason: `working tree has changes: ${changed.slice(0, 8).join(" | ")}` };
  const nestedRelativePaths = nestedWorkspaces.map((workspace) => path.relative(record.path, workspace));
  const ignored = lines
    .filter((line) => line.startsWith("!! "))
    .filter((line) => !nestedRelativePaths.includes(line.slice(3).replace(/\/$/u, "")))
    .filter((line) => {
      const candidate = path.resolve(record.path, line.slice(3).replace(/\/$/u, ""));
      try { return existsSync(candidate) && directoryHasEntries(candidate); } catch { return true; }
    });
  const head = git(record.path, ["rev-parse", "HEAD"]);
  const refs = record.checkoutType === "clone"
    ? git(record.path, ["for-each-ref", "--format=%(refname)", "refs/heads"])
      .split("\n")
      .filter(Boolean)
    : [];
  const candidates = [...refs, "HEAD"];
  const durableSource = record.durableSourceCommit === null ? [] : [record.durableSourceCommit];
  const local = [];
  for (const ref of candidates) {
    const count = Number(git(record.path, ["rev-list", "--count", ref, "--not", "--remotes", ...durableSource]));
    if (count > 0) local.push(`${ref}:${count}`);
  }
  if (local.length > 0) return { safe: false, sourceRetention: true, reason: `checkout has commits absent from remote refs: ${local.join(", ")}`, head };
  if (ignored.length > 0) return { safe: false, sourceRetention: false, reason: `checkout has unclassified ignored output: ${ignored.slice(0, 8).join(" | ")}`, head };
  if (head === record.durableSourceCommit) return { safe: true, sourceRetention: false, reason: "checkout remains at its durable source commit", head };
  return { safe: true, sourceRetention: false, reason: "every local branch commit exists on a remote ref or in durable source ancestry", head };
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

function drainGc(statePath, scopedIds) {
  const root = path.join(path.dirname(statePath), "gc");
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (scopedIds !== undefined && !scopedIds.some(id => entry.name.startsWith(`${id}-`))) continue;
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
  return [...new Set([...DEFAULT_CACHE_PATHS, ...record.cachePaths, ...repositoryManifestCachePaths(record.path)])];
}

function stripCaches(record, statePath, invalidateCapacity) {
  const removed = [];
  const seen = new Set();
  for (const target of cacheTargets(record.path, effectiveCachePaths(record))) {
    if (seen.has(target) || !within(record.path, target) || target === record.path || !existsSync(target)) continue;
    seen.add(target);
    if (holdsTrackedFiles(target)) continue;
    const cacheKey = createHash("sha256").update(path.relative(record.path, target)).digest("hex").slice(0, 12);
    const destination = gcDestination(statePath, record, `${path.basename(target)}-${cacheKey}`);
    invalidateCapacity();
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
  const threads = (options.safety?.threads ?? []).filter((thread) => within(record.path, thread.cwd));
  if (threads.length > 0) {
    return { classification: "referenced", reason: `${threads.length} thread(s) with unfinished custody use this checkout: ${threads.map((thread) => thread.id).join(", ")}`,
      threads, processes: [], containers: [], systemdUnits: [] };
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
    sourceRetention: disposition.sourceRetention,
    processes,
    containers: docker.references,
    systemdUnits: systemd.references,
    head: disposition.head,
  };
}

function reconcileRecord(database, record, options) {
  if (generatedOnlySourceCustody(database, record.id) || recordRetainsCustody(database, record.id) || retainedParent(database,record.path)) return retainedCustodyResult(record);
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
  if (inspection.classification === "referenced" && options.execute && options.reapExpired && !options.preserveRuntime) {
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
  if (options.execute && options.reapExpired && options.preserveRuntime
    && inspection.classification === "repair-required" && inspection.sourceRetention) {
    updateState(database, record, "repair-required", inspection.reason);
    return { record, inspection, action: "none" };
  }
  let removedCaches = [];
  if (options.execute) {
    safety = freshThreadSafety(safety);
    inspection = inspectRecord(record, { ignoreLease: true, safety, deadline: options.deadline });
    if (inspection.classification === "referenced" || inspection.classification === "blocked") {
      updateState(database, record, inspection.classification, inspection.reason);
      return { record, inspection, action: "none" };
    }
    removedCaches = stripCaches(record, options.statePath, () => database.prepare("DELETE FROM workspace_capacity_measurement WHERE workspace_id=?").run(record.id));
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
  const latest = inspectRecord(current, { ignoreLease: true, safety: freshThreadSafety(safety), deadline: options.deadline });
  if (latest.classification !== "reclaimable") {
    updateState(database, current, latest.classification, latest.reason);
    return { record: current, inspection: latest, action: "none" };
  }
  updateState(database, current, "reclaiming", latest.reason);
  removeWorkspace(current, options.statePath);
  removeEmptyWorkspaceContainer(current);
  updateState(database, current, "released", inspection.reason);
  return { record: current, inspection, action: "released" };
}

function recordsInGroup(database, record) {
  if (record.groupId === null) return [record];
  return database.prepare(`SELECT workspace.*, ${ASSIGNMENT_SOURCE} FROM workspace WHERE group_id = ? ORDER BY root, path`)
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
  if (records.some(record => generatedOnlySourceCustody(database, record.id) || recordRetainsCustody(database, record.id) || retainedParent(database,record.path))) return records.map(retainedCustodyResult);
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
  if (options.execute && options.reapExpired && !options.preserveRuntime && inspections.some((inspection) => inspection.classification === "referenced")) {
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

  const preserveKnownSource = options.reapExpired && options.preserveRuntime
    && inspections.some((inspection) => inspection.classification === "repair-required" && inspection.sourceRetention);
  const removedCaches = new Map();
  if (options.execute && !preserveKnownSource && !inspections.some((inspection) => ["referenced", "blocked"].includes(inspection.classification))) {
    safety = freshThreadSafety(safety);
    inspections = records.map((record) => inspectRecord(record,
      groupInspectionOptions(record, records, { ignoreLease: true, safety, deadline: options.deadline })));
  }
  if (options.execute && !preserveKnownSource && !inspections.some((inspection) => ["referenced", "blocked"].includes(inspection.classification))) {
    records.forEach((record, index) => {
      if (inspections[index].classification !== "missing") {
        removedCaches.set(record.id, stripCaches(record, options.statePath, () => database.prepare("DELETE FROM workspace_capacity_measurement WHERE workspace_id=?").run(record.id)));
      }
    });
    inspections = records.map((record) => inspectRecord(record,
      groupInspectionOptions(record, records, { ignoreLease: true, safety, deadline: options.deadline })));
  }

  if (options.execute && !preserveKnownSource && !inspections.some((inspection) => ["referenced", "blocked"].includes(inspection.classification))) {
    safety = freshThreadSafety(safety);
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
    const current = execute && record.state !== "creating" && !(error instanceof ResourceBusyError)
      ? updateState(database, record, "blocked", detail) : record;
    return {
      record: current,
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
        const maintenance = duringInspection(options.deadline, () => new Map(current.map((record) => [record.id, generatedOnlySourceCustody(database, record.id) || recordRetainsCustody(database, record.id) || retainedParent(database, record.path) ? "retained-custody" : maintainReferenceClone(record.path, options.execute, options.statePath)])));
        const reconciled = current.length > 1 ? groupReconciliation(database, current, options)
          : current.length === 1 ? [reconcileRecord(database, current[0], options)] : [];
        return reconciled.map((result) => ({
          ...result,
          record: options.execute ? recordBy(database, { id: result.record.id }) : result.record,
          gitMaintenance: maintenance.get(result.record.id),
        }));
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
    assertMetadata: Object.fromEntries([
      ["owner", one(args, "owner")], ["sourceCommit", one(args, "source-commit")],
      ["mode", one(args, "mode")], ["kind", one(args, "kind")],
      ["root", one(args, "root") === undefined ? undefined : path.resolve(one(args, "root"))],
    ].filter(([, value]) => value !== undefined)),
    leaseSeconds: numberFlag(args, "lease-seconds", DEFAULT_LEASE_SECONDS),
    cachePaths: cachePathsForRepository(selectedPath, args),
    replaceCachePaths: bool(args, "replace-cache"),
  });
  print(creationRecord(database, record.id), bool(args, "json"));
}

/** @typedef {'workspace-not-registered' | 'path-mismatch' | 'state-not-reassignable' | 'state-mismatch' | 'mode-not-writer' | 'owner-mismatch' | 'source-mismatch' | 'assignment-unchanged' | 'assignment-history-mismatch' | 'checkout-type-mismatch' | 'repository-mismatch' | 'writer-branch-unknown' | 'head-mismatch' | 'checkout-inspection-failed' | 'resource-busy' | 'reassignment-failed'} ReassignmentErrorCode */
/** @typedef {{ok: true, record: object, transfer: object} | {ok: false, error: {code: ReassignmentErrorCode, detail: string}}} ReassignmentResult */

/** @returns {ReassignmentResult} */
function reassignWorkspace(database, input) {
  const refuse = (code, detail) => ({ ok: false, error: { code, detail } });
  const row = database.prepare(`SELECT workspace.*, ${ASSIGNMENT_SOURCE} FROM workspace WHERE id = ?`).get(input.id);
  if (row === undefined) return refuse("workspace-not-registered", input.id);
  const record = rowToRecord(row);
  if (recordRetainsCustody(database, record.id)) return refuse("growth-admission-required", "resume-growth admission required before reassignment");
  if (record.path !== input.path) return refuse("path-mismatch", `recorded ${record.path}, requested ${input.path}`);
  if (!["active", "referenced", "blocked", "repair-required"].includes(record.state)) {
    return refuse("state-not-reassignable", record.state);
  }
  if (record.state !== input.fromState) return refuse("state-mismatch", `recorded ${record.state}, expected ${input.fromState}`);
  if (record.mode !== "writer") return refuse("mode-not-writer", record.mode);
  if (record.owner !== input.fromOwner) return refuse("owner-mismatch", `recorded ${record.owner}, expected ${input.fromOwner}`);
  if (record.sourceCommit !== input.fromSourceCommit) {
    return refuse("source-mismatch", `recorded ${record.sourceCommit}, expected ${input.fromSourceCommit}`);
  }
  if (record.owner === input.owner && record.sourceCommit === input.sourceCommit) {
    return refuse("assignment-unchanged", "owner and source already match; no handoff recorded");
  }
  const last = database.prepare("SELECT new_owner, new_source_commit FROM workspace_reassignment WHERE workspace_id = ? ORDER BY sequence DESC LIMIT 1").get(record.id);
  if (last !== undefined && (last.new_owner !== record.owner || last.new_source_commit !== record.sourceCommit)) {
    return refuse("assignment-history-mismatch", "current assignment differs from its last handoff");
  }
  let info;
  try {
    info = gitInfo(record.path);
    if (retainedParent(database,record.path)) return refuse("growth-admission-required", "shared Git parent growth is retired");
    if (info.checkoutType !== record.checkoutType) return refuse("checkout-type-mismatch", `recorded ${record.checkoutType}, observed ${info.checkoutType}`);
    if (info.repository === null || info.repository !== record.repository) {
      return refuse("repository-mismatch", `recorded ${record.repository}, observed ${info.repository}`);
    }
    const branch = command("git", ["-C", record.path, "symbolic-ref", "--quiet", "HEAD"]);
    if (branch.status !== 0) return refuse("writer-branch-unknown", "writer HEAD must be attached to a branch");
    if (info.head !== input.sourceCommit) return refuse("head-mismatch", `observed ${info.head}, requested ${input.sourceCommit}`);
  } catch (error) {
    return refuse("checkout-inspection-failed", error instanceof Error ? error.message : String(error));
  }
  const transfer = {
    workspaceId: record.id, path: record.path,
    oldOwner: record.owner, oldSourceCommit: record.sourceCommit,
    newOwner: input.owner, newSourceCommit: input.sourceCommit,
    authorization: input.authorization, occurredAt: Date.now(),
  };
  const event = database.prepare(`INSERT INTO workspace_reassignment
    (workspace_id, path, old_owner, old_source_commit, new_owner, new_source_commit, authorization, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(record.id, record.path, record.owner, record.sourceCommit,
    input.owner, input.sourceCommit, input.authorization, transfer.occurredAt);
  // source_commit stays immutable so clients from an earlier release cannot discard a new, unpublished baseline.
  database.prepare("UPDATE workspace SET owner = ?, updated_at = ? WHERE id = ?").run(input.owner, transfer.occurredAt, record.id);
  return { ok: true, record: recordBy(database, { id: record.id }), transfer: { sequence: Number(event.lastInsertRowid), ...transfer } };
}

function reassignCommand(database, args) {
  assertOnly(args, ["id", "path", "from-owner", "from-source-commit", "from-state", "owner", "source-commit", "authorization", "json"]);
  const fromSource = required(args, "from-source-commit");
  const sourceCommit = required(args, "source-commit");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sourceCommit) ||
    (fromSource !== "unset" && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(fromSource))) {
    fail("source commits must be full lowercase Git object IDs; --from-source-commit may also be unset");
  }
  const input = {
    id: required(args, "id"), path: path.resolve(required(args, "path")),
    fromOwner: required(args, "from-owner"), fromSourceCommit: fromSource === "unset" ? null : fromSource,
    fromState: required(args, "from-state"), owner: required(args, "owner"), sourceCommit,
    authorization: required(args, "authorization"),
  };
  if ([input.fromOwner, input.owner, input.authorization].some(value => !value.trim())) {
    fail("handoff owners and authorization must be nonempty");
  }
  let result;
  try {
    result = withWorkspaceLock(database, input.path, () => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const outcome = reassignWorkspace(database, input);
        database.exec(outcome.ok ? "COMMIT" : "ROLLBACK");
        return outcome;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  } catch (error) {
    result = { ok: false, error: {
      code: error instanceof ResourceBusyError ? "resource-busy" : "reassignment-failed",
      detail: error instanceof Error ? error.message : String(error),
    } };
  }
  if (bool(args, "json")) print(result, true);
  else if (result.ok) print(result.record, false);
  if (!result.ok) {
    process.stderr.write(`agent-workspace: ${result.error.code}: ${result.error.detail}\n`);
    process.exitCode = result.error.code === "resource-busy" ? 75 : 2;
  }
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
    if (!entry.isDirectory() || entry.isSymbolicLink() || /^\..+\.creating-[0-9a-f-]{36}(?:-\d+-\d+)?$/.test(entry.name)) continue;
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
    for (const registration of registrations) {
      const row = database.prepare("SELECT id FROM workspace WHERE path=?").get(registration.path);
      if ((row && recordRetainsCustody(database,row.id)) || retainedParent(database,registration.path)) growthError("growth-admission-required", "retained custody cannot be adopted or maintained before admission");
    }
    const prepared = registrations
      .filter((registration) => existsSync(registration.path) && gitRoot(registration.path))
      .map((registration) => ({
        ...registration,
        cachePaths: cachePathsForRepository(registration.path, args),
        inspection: registrationInspection(registration.path, statePath),
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

function capacityIntent(args) {
  const intent = one(args, "intent");
  if (intent === undefined) {
    if (one(args, "headroom-gib") !== undefined || one(args, "growth-mib") !== undefined) fail("--headroom-gib and --growth-mib require explicit --intent source-only or budgeted");
    return null;
  }
  if (!["source-only", "budgeted"].includes(intent)) fail("--intent must be source-only or budgeted");
  if (one(args, "min-free-gib") !== undefined) fail("budgeted intent uses --headroom-gib, not --min-free-gib");
  required(args, "headroom-gib");
  required(args, "growth-mib");
  const headroomBytes = Math.ceil(numberFlag(args, "headroom-gib") * 1024 ** 3);
  const growthBytes = Math.ceil(numberFlag(args, "growth-mib") * 1024 ** 2);
  if (!Number.isSafeInteger(headroomBytes) || headroomBytes <= 0 || !Number.isSafeInteger(growthBytes)) fail("capacity budgets require positive headroom and nonnegative growth within the supported byte range");
  return { intent, headroomBytes, growthBytes };
}

function sparseSourcePaths(entries, patterns) {
  if (patterns.length === 0) return null;
  const scratch = mkdtempSync(path.join(tmpdir(), "pi-workspace-selection-"));
  try {
    run("git", ["init", "--quiet", scratch]);
    const empty = git(scratch, ["hash-object", "-w", "--stdin"], { input: "" });
    const symlink = git(scratch, ["hash-object", "-w", "--stdin"], { input: "." });
    const topology = entries.map(({ mode, type, hash, name }) =>
      `${mode} ${type === "commit" ? hash : mode === "120000" ? symlink : empty}\t${name}\0`).join("");
    git(scratch, ["update-index", "--add", "-z", "--index-info"], { input: topology });
    const tree = git(scratch, ["write-tree"]);
    git(scratch, ["read-tree", "--empty"]);
    const rules = path.join(scratch, ".git", "info", "sparse-checkout");
    writeFileSync(rules, `${patterns.join("\n")}\n`, { mode: 0o600 });
    // Ask checkout itself: ignore-pattern queries disagree on directory reinclusions.
    // Identical path/mode topology with tiny blobs avoids opening any source blob.
    git(scratch, ["-c", "core.sparseCheckout=true", "-c", "core.sparseCheckoutCone=false", "read-tree", "-m", "-u", tree]);
    return new Set(git(scratch, ["ls-files", "-t", "-z"]).split("\0")
      .filter(entry => entry.startsWith("H ")).map(entry => entry.slice(2)));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function sourceCapacityPlan(repository, sourceCommit, intent, blockSize, mirror, sparsePatterns = []) {
  if (!existsSync(repository)) {
    if (!mirror || !existsSync(mirror) || existsSync(path.join(mirror, "objects", "info", "alternates"))) {
      fail("source capacity estimate unknown: remote commit needs independent durable mirror custody; remote import remains unestimated");
    }
    const resolved = command("git", ["--git-dir", mirror, "rev-parse", "--verify", `${sourceCommit}^{commit}`]);
    if (resolved.status !== 0 || resolved.stdout !== sourceCommit || !hasObjectClosure(mirror, sourceCommit, sparsePatterns)) {
      fail("source capacity estimate unknown: remote commit closure is absent from durable mirror custody; remote import remains unestimated (refetch through that route)");
    }
    repository = mirror;
  }
  const plan = sourceCheckoutCapacity(repository, sourceCommit, intent, blockSize, sparsePatterns);
  const imported = sourceImportCapacity(repository, sourceCommit, mirror, sparsePatterns);
  const sourceImportBytes = imported.bytes;
  const constructionBytes = plan.constructionBytes + sourceImportBytes;
  if (!Number.isSafeInteger(constructionBytes)) fail("source capacity estimate exceeds supported byte range");
  return { ...plan, constructionBytes, sourceImportBytes, sourceImportBaseCommits: imported.baseCommits };
}

function assertSourceCheckoutFilters(repository) {
  const filters = command("git", ["-C", repository, "config", "--get-regexp", "^filter\\..*\\.(smudge|process)$"]);
  if (filters.status !== 1) fail("source capacity estimate unknown: configured checkout filters need an independently budgeted installer");
}

function sourceCheckoutCapacity(repository, sourceCommit, intent, blockSize, sparsePatterns = []) {
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) fail("source capacity estimate unknown: invalid filesystem allocation unit");
  assertSourceCheckoutFilters(repository);
  const { entries, selected } = sourceTree(repository, sourceCommit, sparsePatterns);
  for (const { name } of entries) {
    if (name.endsWith(".gitattributes") && /(?:working-tree-encoding|filter)=/u.test(git(repository, ["show", `${sourceCommit}:${name}`]))) {
      fail("source capacity estimate unknown: checkout attribute transformation");
    }
  }
  const checkoutAllocation = checkoutConstructionCapacity(entries, selected, blockSize);
  return { ...intent, estimate: selected === null ? "whole-tree-upper-bound" : "git-sparse-upper-bound",
    constructionBytes: checkoutAllocation.totalBytes, checkoutAllocation, checkoutPricingVersion: 4, sourceImportBytes: 0, sourceCommit };
}

function checkoutConstructionCapacity(entries, selected, blockSize) {
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) fail("invalid filesystem allocation unit");
  let indexBytes = 0, materializedBlobBytes = 0, materializedMetadataBytes = 0;
  const topologyDirectories = new Set(), materializedDirectories = new Set();
  for (const { name, size } of entries) {
    // Excluded files occupy records in a shared index, not separate inodes.
    // Four uncompressed index/tree records cover index rewrites and the
    // temporary same-topology selector. Keep full path bytes even for v4 indexes.
    indexBytes += 4 * (128 + Buffer.byteLength(name));
    const materialized = selected === null || selected.has(name);
    for (let at = name.indexOf("/"); at !== -1; at = name.indexOf("/", at + 1)) {
      const directory = name.slice(0, at);
      topologyDirectories.add(directory);
      if (materialized) materializedDirectories.add(directory);
    }
    if (materialized) {
      materializedBlobBytes += size === undefined ? 0 : 2 * Math.ceil(Number(size) / blockSize) * blockSize;
      materializedMetadataBytes += 4 * blockSize;
    }
  }
  // The selector writes a Git tree object for every source directory. Only
  // selected paths need filesystem directories in the checkout/staging tree.
  const topologyBytes = topologyDirectories.size * 4 * blockSize;
  materializedMetadataBytes += materializedDirectories.size * 4 * blockSize;
  const fixedBytes = 16 * 1024 ** 2;
  const totalBytes = fixedBytes + indexBytes + topologyBytes + materializedMetadataBytes + materializedBlobBytes;
  if (!Number.isSafeInteger(totalBytes)) fail("source capacity estimate exceeds supported byte range");
  return { fixedBytes, indexBytes, topologyBytes, materializedMetadataBytes, materializedBlobBytes,
    sourcePaths: entries.length, sourceDirectories: topologyDirectories.size, materializedDirectories: materializedDirectories.size, totalBytes };
}

function importBaseCommits(repository, sourceCommit, mirror) {
  const baseCommits = [];
  if (mirror && existsSync(mirror) && !existsSync(path.join(mirror, "objects", "info", "alternates"))) {
    const tips = [...new Set(git(mirror, ["for-each-ref", "--sort=-committerdate", "--format=%(objectname)"]).split("\n").filter(Boolean))];
    // Bound qualification work; omitting older tips only overestimates import.
    for (const tip of tips.slice(0, 16)) {
      const common = command("git", ["-C", repository, "merge-base", "--all", tip, sourceCommit]);
      if (common.status !== 0) continue;
      for (const base of common.stdout.split("\n").filter(Boolean)) {
        if (!baseCommits.includes(base) && hasObjectClosure(mirror, base)) baseCommits.push(base);
      }
    }
  }
  return baseCommits;
}

function sourceImportCapacity(repository, sourceCommit, mirror, sparsePatterns) {
  if (mirror && existsSync(mirror) && hasObjectClosure(mirror, sourceCommit, sparsePatterns)) return { bytes: 0, baseCommits: [sourceCommit] };
  const baseCommits = importBaseCommits(repository, sourceCommit, mirror);
  const objects = git(repository, ["rev-list", "--objects", "--no-object-names", sourceCommit, ...baseCommits.map(tip => `^${tip}`)]);
  const sizes = run("git", ["-C", repository, "cat-file", "--batch-check=%(objectsize)"], { input: `${objects}\n` });
  let bytes = 16 * 1024 ** 2;
  for (const size of sizes.split("\n")) {
    if (!/^\d+$/u.test(size)) fail("source capacity estimate unknown: source history object is unavailable");
    // Pack construction can temporarily hold both incoming and installed files.
    bytes += 2 * (Number(size) + Math.ceil(Number(size) / 1000) + 128);
  }
  if (!Number.isSafeInteger(bytes)) fail("source history capacity exceeds supported byte range");
  return { bytes, baseCommits };
}

function capacityRequirement(plan, reservations, sharedHeadroomBytes = 0) {
  for (const value of [plan.constructionBytes, plan.growthBytes, plan.headroomBytes, sharedHeadroomBytes, ...reservations]) {
    if (!Number.isSafeInteger(value) || value < 0) fail("invalid capacity ledger byte budget");
  }
  const unestimated = plan.intent === "unestimated";
  const constructionBytes = unestimated ? 0 : plan.constructionBytes;
  const headroomBytes = unestimated ? Math.max(plan.constructionBytes, plan.headroomBytes) : plan.headroomBytes;
  const requiredBytes = constructionBytes + plan.growthBytes + Math.max(headroomBytes, sharedHeadroomBytes) + reservations.reduce((sum, bytes) => sum + bytes, 0);
  if (!Number.isSafeInteger(requiredBytes)) fail("capacity ledger total exceeds supported byte range");
  return requiredBytes;
}

function creationFenceBusy(database, workspacePath) {
  const statePath = registryPaths.get(database) ?? database.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file;
  if (!statePath) fail("capacity estimate unknown: creation fence registry path unavailable");
  const directory = path.join(path.dirname(statePath), "locks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, createHash("sha256").update(`checkout:${path.resolve(workspacePath)}`).digest("hex"));
  const descriptor = openSync(file, "a", 0o600);
  try {
    const result = spawnSync("flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "pipe", "pipe", descriptor], timeout: 1000 });
    if (result.status === 0) return false;
    if (result.status === 1) return true;
    fail("capacity estimate unknown: cannot inspect pending creation fence");
  } finally { closeSync(descriptor); }
}

function allocatedWorkspaceBytes(workspacePath, device, { deadline = Date.now() + 500, maxEntries = 50_000, excludedPaths = [] } = {}) {
  const excluded = new Set(excludedPaths);
  const seen = new Set();
  let entries = 0;
  let bytes = 0;
  let allocatedBytes = 0;
  function walk(file) {
    if (excluded.has(file)) return;
    if (++entries > maxEntries || Date.now() >= deadline) throw new Error("allocated-block measurement budget exhausted");
    const stats = lstatSync(file);
    if (String(stats.dev) !== device) {
      if (file === workspacePath) throw new Error("workspace moved to another filesystem");
      return;
    }
    const inode = `${stats.dev}:${stats.ino}`;
    if (seen.has(inode)) return;
    seen.add(inode);
    const blocks = stats.blocks * 512;
    if (!Number.isSafeInteger(blocks) || blocks < 0) throw new Error("invalid allocated-block count");
    allocatedBytes += blocks;
    // Shared inodes cannot spend two workspaces' growth budgets.
    if (stats.isDirectory() || stats.nlink === 1) bytes += blocks;
    if (!Number.isSafeInteger(allocatedBytes)) throw new Error("allocated-block total exceeds supported byte range");
    if (!stats.isDirectory()) return;
    const directory = opendirSync(file);
    try {
      let entry;
      while ((entry = directory.readSync()) !== null) walk(path.join(file, entry.name));
    } finally { directory.closeSync(); }
  }
  try {
    walk(workspacePath);
    return { ok: true, bytes, allocatedBytes };
  } catch (error) {
    return { ok: false, error: `${error.code ?? "measurement-unavailable"}: ${error.message}` };
  }
}

function remainingCapacityBytes(plan, state, measurement) {
  capacityRequirement(plan, []);
  if (retainedGrowth(plan)) {
    if (state === "creating") growthError("invalid-growth-lifecycle", "pending creation cannot have retired growth");
    return 0;
  }
  const budget = plan.growthBytes + (state === "creating" ? plan.constructionBytes : 0);
  if (!Number.isSafeInteger(budget)) fail("capacity ledger total exceeds supported byte range");
  if (budget === 0 || !measurement.ok) return budget;
  if (!Number.isSafeInteger(measurement.bytes) || measurement.bytes < 0) fail("invalid capacity allocated-block measurement");
  return Math.max(0, budget - Math.max(0, measurement.bytes - capacityAllocationBaseline(plan, state)));
}

function capacityAllocationBaseline(plan, state) {
  const sourceImportBytes = plan.sourceImportBytes ?? 0;
  if (!Number.isSafeInteger(sourceImportBytes) || sourceImportBytes < 0 || sourceImportBytes > plan.constructionBytes) fail("invalid capacity source import budget");
  const baseline = state === "creating" ? 0 : plan.completedAllocationBytes ?? (plan.constructionBytes - sourceImportBytes);
  if (!Number.isSafeInteger(baseline) || baseline < 0) fail("invalid capacity completed allocation baseline");
  return baseline;
}

const CAPACITY_MEASUREMENT_MAX_AGE_MS = 15 * 60_000;
const CAPACITY_MEASUREMENT_MARGIN_BYTES = 64 * 1024 ** 2;

function workspaceAllocationSample(workspacePath, device, options) {
  const startedAt = Date.now();
  try {
    const before = lstatSync(workspacePath);
    if (!before.isDirectory() || String(before.dev) !== device) return { ok: false, startedAt, completedAt: Date.now(), error: "workspace root is not a directory on the reserved filesystem" };
    const allocation = allocatedWorkspaceBytes(workspacePath, device, options);
    if (!allocation.ok) return { ...allocation, startedAt, completedAt: Date.now() };
    const after = lstatSync(workspacePath);
    if (after.dev !== before.dev || after.ino !== before.ino) return { ok: false, startedAt, completedAt: Date.now(), error: "workspace root changed during measurement" };
    return { ...allocation, startedAt, completedAt: Date.now(), device, inode: String(before.ino) };
  } catch (error) {
    return { ok: false, startedAt, completedAt: Date.now(), error: `${error.code ?? "measurement-unavailable"}: ${error.message}` };
  }
}

function cachedWorkspaceAllocation(database, workspaceId, workspacePath, device, now = Date.now()) {
  const row = database.prepare("SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?").get(workspaceId);
  if (row === undefined) return { ok: false, error: "allocated-block cache missing" };
  const sample = JSON.parse(row.measurement_json);
  if (!sample.ok) return { ok: false, error: `allocated-block measurement failed: ${sample.error}` };
  for (const value of [sample.startedAt, sample.completedAt, sample.bytes, sample.allocatedBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) fail("invalid capacity allocation cache");
  }
  if (sample.completedAt < sample.startedAt || sample.completedAt > now || now - sample.startedAt > CAPACITY_MEASUREMENT_MAX_AGE_MS) return { ok: false, error: "allocated-block cache stale or future-dated" };
  try {
    const stats = lstatSync(workspacePath);
    if (!stats.isDirectory() || String(stats.dev) !== device || sample.device !== device || String(stats.ino) !== sample.inode) return { ok: false, error: "allocated-block cache root identity changed" };
  } catch (error) { return { ok: false, error: `allocated-block cache root unavailable: ${error.code ?? error.message}` }; }
  const marginBytes = Math.max(CAPACITY_MEASUREMENT_MARGIN_BYTES, Math.ceil(sample.bytes / 100));
  return { ok: true, bytes: Math.max(0, sample.bytes - marginBytes), allocatedBytes: sample.allocatedBytes,
    startedAt: sample.startedAt, completedAt: sample.completedAt, marginBytes };
}

function capacityReservations(database, device, reservedPath, measure) {
  if (database === undefined) return { priced: [], headroomBytes: 0, unpricedDormant: 0 };
  const unknown = database.prepare(`SELECT w.path, w.root FROM workspace w LEFT JOIN workspace_capacity c ON c.workspace_id=w.id
    WHERE w.state='creating' AND c.workspace_id IS NULL AND w.path!=?`).all(reservedPath ?? "");
  let unpricedDormant = 0;
  for (const row of unknown) {
    let ancestor = row.root;
    while (!existsSync(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
    if (String(statSync(ancestor).dev) !== device) continue;
    if (creationFenceBusy(database, row.path)) fail(`capacity estimate unknown: active legacy creation at ${row.path}; await its owning creator`);
    unpricedDormant += 1;
  }
  let headroomBytes = 0;
  const measurementFailures = [];
  const rows = database.prepare(`SELECT c.plan_json, w.id, w.state, w.path FROM workspace_capacity c JOIN workspace w ON w.id=c.workspace_id
    WHERE c.device_id=? AND w.path!=? AND w.state!='released' ORDER BY w.created_at DESC, w.id`)
    .all(device, reservedPath ?? "");
  const priced = rows.map(row => {
      const plan = JSON.parse(row.plan_json);
      if (!["source-only", "budgeted", "unestimated"].includes(plan.intent) ||
        !(plan.intent === "unestimated" ? ["unknown"] : ["whole-tree-upper-bound", "git-sparse-upper-bound"]).includes(plan.estimate)) fail("invalid capacity ledger intent or estimate");
      capacityRequirement(plan, []);
      headroomBytes = Math.max(headroomBytes, plan.headroomBytes,
        plan.intent === "unestimated" ? plan.constructionBytes : 0);
      const budget = plan.growthBytes + (row.state === "creating" ? plan.constructionBytes : 0);
      if (retainedGrowth(plan)) return remainingCapacityBytes(plan, row.state, {ok:false});
      if (budget === 0) return 0;
      const measurement = measure === undefined ? cachedWorkspaceAllocation(database, row.id, row.path, device) : measure(row.path, device);
      if (!measurement.ok) measurementFailures.push({ path: row.path, error: measurement.error, reservedBytes: budget });
      return remainingCapacityBytes(plan, row.state, measurement);
    }).filter(bytes => bytes > 0);
  return { priced, headroomBytes, unpricedDormant, ...(measurementFailures.length ? { measurementFailures } : {}) };
}

// Diagnostic projection only: the admission decision still uses capacityRequirement.
// Preserve absent source estimates explicitly, and never infer import bytes from
// requested future growth. These are the SAME reservations used by the refusal.
function capacityRefusalDetails(plan, reservations) {
  const requiredBytes = capacityRequirement(plan, reservations.priced, reservations.headroomBytes);
  const unestimated = plan.intent === "unestimated";
  return {
    requiredBytes,
    constructionBytes: unestimated ? 0 : plan.constructionBytes,
    growthBytes: plan.growthBytes,
    requestedHeadroomBytes: plan.headroomBytes,
    sharedHeadroomBytes: reservations.headroomBytes,
    effectiveHeadroomBytes: Math.max(plan.headroomBytes, reservations.headroomBytes,
      unestimated ? plan.constructionBytes : 0),
    otherReservationsBytes: reservations.priced.reduce((sum, bytes) => sum + bytes, 0),
    otherReservationBytes: [...reservations.priced],
    unpricedDormant: reservations.unpricedDormant,
    measurementFailures: reservations.measurementFailures === undefined ? [] : reservations.measurementFailures,
    sourceImport: plan.sourceImportBytes === undefined ? { state: "unset" } : { state: "set", bytes: plan.sourceImportBytes },
    sourceForecast: unestimated ? { state: "unset" } : { state: "set", plan },
  };
}

function assertCapacity(root, args, database, reservedPath, plan, replacedPlan) {
  mkdirSync(root, { recursive: true });
  const maxCount = numberFlag(args, "max-count", DEFAULT_MAX_COUNT);
  if (maxCount > 0) {
    const pending = database?.prepare("SELECT path FROM workspace WHERE root=? AND state='creating'").all(root) ?? [];
    const count = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && path.join(root, entry.name) !== reservedPath).length +
      pending.filter((record) => record.path !== reservedPath && !existsSync(record.path)).length;
    if (count >= maxCount) fail(`workspace root has ${count} checkouts; limit is ${maxCount}. Reconcile it before creating another.`);
  }
  const device = String(statSync(root).dev);
  const reservations = capacityReservations(database, device, reservedPath);
  for (const failure of reservations.measurementFailures ?? []) {
    process.stderr.write(`capacity measurement unavailable at ${failure.path}; retaining full ${(failure.reservedBytes / 1024 ** 3).toFixed(2)} GiB reservation: ${failure.error}\n`);
  }
  const stats = statfsSync(root);
  const freeBytes = stats.bavail * stats.bsize;
  const minimum = Math.ceil(numberFlag(args, "min-free-gib", DEFAULT_MIN_FREE_GIB) * 1024 ** 3);
  const requirement = capacityRequirement(plan ?? { intent: "unestimated", constructionBytes: minimum, headroomBytes: 0, growthBytes: 0 }, reservations.priced, reservations.headroomBytes);
  let reductionEvidence;
  if (replacedPlan !== undefined) {
    // Both requirements use ONE physical observation and ONE unchanged set of
    // other reservations. This retires existing liability; it creates no space
    // and grants no new writes even when the host is already oversubscribed.
    const previousRequiredBytes = capacityRequirement(replacedPlan, reservations.priced, reservations.headroomBytes);
    const deficitBytesBefore = Math.max(0, previousRequiredBytes - freeBytes);
    const deficitBytesAfter = Math.max(0, requirement - freeBytes);
    if (plan.constructionBytes !== 0 || replacedPlan.constructionBytes !== 0 ||
        plan.growthBytes >= replacedPlan.growthBytes || requirement >= previousRequiredBytes ||
        plan.headroomBytes < Math.max(replacedPlan.headroomBytes, 8 * 1024 ** 3) ||
        deficitBytesAfter > deficitBytesBefore) {
      growthError("unsafe-growth-reduction", "replacement must strictly lower existing liability without worsening the capacity deficit");
    }
    reductionEvidence = {kind:"monotone-reduction", previousRequiredBytes, deficitBytesBefore, deficitBytesAfter,
      releasedReservationBytes:previousRequiredBytes-requirement, newWritesAuthorized:false};
  }
  if (replacedPlan === undefined && freeBytes < requirement) {
    const capacity = { freeBytes, requiredBytes: requirement, device, observedAt: Date.now(),
      breakdown: capacityRefusalDetails(plan ?? { intent: "unestimated", constructionBytes: minimum, headroomBytes: 0, growthBytes: 0 }, reservations) };
    // The guarded create wrapper preserves stderr but not thrown object fields.
    // Carry the complete typed observation in both retained forecast and stderr,
    // without another filesystem/reservation read or a new admission attempt.
    throw Object.assign(new CliError(`${(freeBytes / 1024 ** 3).toFixed(2)} GiB is free; ${(requirement / 1024 ** 3).toFixed(2)} GiB is required${plan?.intent !== undefined && plan.intent !== "unestimated" ? " (source forecast + declared growth + operating headroom + other reservations)" : " (unestimated full work + other reservations)"}\ncapacity-detail: ${JSON.stringify(capacity)}`),
      { code: "workspace-capacity-refused", capacity });
  }
  const freeInodes = stats.files > 0 ? 100 * stats.ffree / stats.files : 100;
  const minFreeInodes = numberFlag(args, "min-free-inodes-percent", DEFAULT_MIN_FREE_INODES_PERCENT);
  if (freeInodes < minFreeInodes) fail(`${freeInodes.toFixed(2)}% of inodes are free; ${minFreeInodes.toFixed(2)}% is required`);
  return { ...reductionEvidence, freeBytes, requiredBytes: requirement, reservedBytes: reservations.priced.reduce((sum, bytes) => sum + bytes, 0),
    sharedHeadroomBytes: reservations.headroomBytes, unpricedDormant: reservations.unpricedDormant,
    ...(reservations.measurementFailures ? { measurementFailures: reservations.measurementFailures } : {}) };
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

function renameAlternate(file, objectSource) {
  const temporary = `${file}.${randomUUID()}`;
  try {
    writeFileSync(temporary, `${objectSource}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

function stabilizeObjectCustody(workspace, alternates, execute, statePath) {
  if (!statePath) fail("reference clone custody requires the owning workspace registry");
  const mirrorRoot = path.join(path.dirname(statePath), "mirrors");
  const objectDirectory = path.dirname(path.dirname(alternates));
  const stores = readFileSync(alternates, "utf8").split("\n").filter(Boolean)
    .map(value => path.resolve(objectDirectory, value));
  if (stores.every(store => existsSync(store) && path.basename(store) === "objects"
    && path.dirname(path.dirname(store)) === mirrorRoot
    && !existsSync(path.join(store, "info", "alternates")))) return "durable-mirror";
  if (!execute) return "would-import-durable-mirror";
  const upstream = repositoryRemotes(workspace);
  const mirror = mirrorFor(statePath, upstream.fetch);
  withResourceLock(statePath, `mirror:${mirror}`, () => {
    prepareMirror(mirror, workspace, upstream);
    const objects = new Set([
      git(workspace, ["rev-parse", "--verify", "HEAD"]),
      ...git(workspace, ["for-each-ref", "--format=%(objectname)"]).split("\n"),
      ...git(workspace, ["reflog", "--all", "--format=%H"]).split("\n"),
    ].filter(Boolean));
    const refs = [...objects].map(object => `+${object}:refs/pi-workspace/objects/${object}`);
    for (let index = 0; index < refs.length; index += 128) {
      run("git", ["--git-dir", mirror, "fetch", "--no-tags", "--no-auto-maintenance", workspace,
        ...refs.slice(index, index + 128)], { timeout: 120_000 });
    }
    renameAlternate(alternates, path.join(mirror, "objects"));
  });
  return "imported-durable-mirror";
}

const closureEnvironment = { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_ALTERNATE_OBJECT_DIRECTORIES: "" };

function objectStoreStamp(mirror) {
  const objects = path.join(mirror, "objects");
  if (!existsSync(objects)) return null;
  const digest = createHash("sha256");
  const add = file => {
    try {
      const s = statSync(file, { bigint: true });
      digest.update(`${file}\0${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}\n`);
    } catch (error) { if (error.code !== "ENOENT") throw error; digest.update(`${file}\0absent\n`); }
  };
  add(objects);
  for (let byte = 0; byte < 256; byte++) add(path.join(objects, byte.toString(16).padStart(2, "0")));
  for (const directory of ["pack", "info"]) {
    const root = path.join(objects, directory); add(root);
    if (existsSync(root)) for (const name of readdirSync(root).sort()) add(path.join(root, name));
  }
  for (const name of ["shallow", "config"]) add(path.join(mirror, name));
  return digest.digest("hex");
}

function sourceTree(repository, commit, sparsePatterns) {
  const entries = git(repository, ["ls-tree", "-rz", commit], { env: closureEnvironment }).split("\0").filter(Boolean).map(entry => {
    const match = entry.match(/^(\d+) (blob|commit) ([0-9a-f]+)\t(.+)$/su);
    if (match === null) fail("source capacity estimate unknown: malformed Git tree entry");
    const [, mode, type, hash, name] = match;
    return { mode, type, hash, name };
  });
  const selected = sparseSourcePaths(entries, sparsePatterns);
  const needed = entries.filter(entry => entry.type === "blob" && (selected === null || selected.has(entry.name) || entry.name.endsWith(".gitattributes")));
  const result = command("git", ["-C", repository, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { env: closureEnvironment, input: needed.map(entry => entry.hash).join("\n") + "\n" });
  const rows = needed.length === 0 ? [] : result.stdout.split("\n");
  if (result.status !== 0 || rows.length !== needed.length) fail("source capacity estimate unknown: selected source object is unavailable");
  for (let index = 0; index < needed.length; index++) {
    const match = rows[index].match(/^([0-9a-f]+) blob (\d+)$/u);
    if (match === null || match[1] !== needed[index].hash) fail("source capacity estimate unknown: selected source object is unavailable");
    needed[index].size = match[2];
  }
  return { entries, selected };
}

function hasObjectClosure(mirror, commit, sparsePatterns = []) {
  if (!existsSync(mirror) || existsSync(path.join(mirror, "objects", "info", "alternates"))) return false;
  const before = objectStoreStamp(mirror);
  if (before === null) return false;
  const key = createHash("sha256").update(JSON.stringify([commit, sparsePatterns])).digest("hex");
  const directory = path.join(mirror, "pi-workspace-closure");
  const file = path.join(directory, `${key}.json`);
  if (existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, "utf8"));
    if (cached.version === 1 && cached.stamp === before && cached.commit === commit) return true;
  }
  let verified;
  if (sparsePatterns.length === 0) {
    verified = command("git", ["--git-dir", mirror, "rev-list", "--objects", "--quiet", "--missing=error", `${commit}^{commit}`],
      { env: closureEnvironment }).status === 0;
  } else {
    const root = command("git", ["--git-dir", mirror, "cat-file", "-e", `${commit}^{tree}`], { env: closureEnvironment });
    if (root.status !== 0) return false;
    try { sourceTree(mirror, commit, sparsePatterns); verified = true; }
    catch (error) { if (!(error instanceof CliError)) throw error; return false; }
  }
  if (!verified || objectStoreStamp(mirror) !== before) return false;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify({ version: 1, commit, sparsePatterns, stamp: before }), { mode: 0o600 });
  renameSync(temporary, file);
  return true;
}

function cachedImmutableSource(mirror, repository, ref, sparsePatterns) {
  if (!/^[0-9a-f]{40}$/u.test(ref) || !existsSync(mirror)) return null;
  if (existsSync(path.join(mirror, "objects", "info", "alternates"))) fail(`shared mirror must own its objects independently: ${mirror}`);
  const cached = command("git", ["--git-dir", mirror, "rev-parse", "--verify", `${sourceRefFor(repository, ref)}^{commit}`]);
  return cached.status === 0 && cached.stdout === ref && hasObjectClosure(mirror, ref, sparsePatterns) ? ref : null;
}

function resolveRequestedSource(repository, ref) {
  if (existsSync(repository)) {
    const resolved = command("git", ["-C", repository, "rev-parse", "--verify", `${ref}^{commit}`]);
    if (resolved.status !== 0) fail(`cannot resolve source ${ref}: ${resolved.stderr}`);
    ref = resolved.stdout;
  } else if (!/^[0-9a-f]{4,40}$/u.test(ref)) {
    const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
    const advertised = run("git", ["ls-remote", "--exit-code", repository,
      ...candidates.flatMap(candidate => [candidate, `${candidate}^{}`])]);
    const refs = new Map(advertised.split("\n").map(line => {
      const [commit, name] = line.split(/\s+/u);
      return [name, commit];
    }));
    const named = candidates.find(candidate => refs.has(candidate));
    if (named === undefined) fail(`cannot resolve source ${ref}; provide an exact remote ref or full commit`);
    ref = refs.get(`${named}^{}`) ?? refs.get(named);
  }
  return ref;
}

function resolveSource(statePath, mirror, repository, upstream, ref, sparsePatterns = []) {
  ref = resolveRequestedSource(repository, ref);
  const cached = cachedImmutableSource(mirror, repository, ref, sparsePatterns);
  if (cached !== null) return cached;
  return withResourceLock(statePath, `mirror:${mirror}`, () => {
    const shared = cachedImmutableSource(mirror, repository, ref, sparsePatterns);
    if (shared !== null) return shared;
    if (existsSync(path.join(mirror, "objects", "info", "alternates"))) fail(`shared mirror must own its objects independently: ${mirror}`);
    if (/^[0-9a-f]{40}$/u.test(ref) && existsSync(mirror)
      && hasObjectClosure(mirror, ref, sparsePatterns)) {
      run("git", ["--git-dir", mirror, "update-ref", sourceRefFor(repository, ref), ref]);
      return ref;
    }
    if (sourcePreparationMode === "foreground") throw new SourcePreparationRequired();
    if (sourceJobDirectory !== null) writeSourceJobProgress(sourceJobDirectory, { phase: "importing", commit: ref });
    prepareMirror(mirror, repository, upstream);
    if (/^[0-9a-f]{4,39}$/u.test(ref)) {
      run("git", ["--git-dir", mirror, "fetch", "--prune", "--no-tags", "origin"], { timeout: 120_000 });
    }
    return fetchSource(mirror, repository, ref, sparsePatterns);
  });
}

function prepareMirror(mirror, repository, upstream) {
  mkdirSync(path.dirname(mirror), { recursive: true, mode: 0o700 });
  if (!existsSync(mirror)) run("git", ["init", "--bare", mirror]);
  if (existsSync(path.join(mirror, "objects", "info", "alternates"))) fail(`shared mirror must own its objects independently: ${mirror}`);
  for (const [name, value] of Object.entries({ ...REFERENCE_CLONE_CONFIG, "fetch.unpackLimit": "1" })) {
    run("git", ["--git-dir", mirror, "config", "--local", name, value]);
  }
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
}

function fetchSource(mirror, repository, ref, sparsePatterns) {
  let resolved = ref;
  if (/^[0-9a-f]{4,39}$/u.test(ref)) {
    const source = existsSync(repository) ? ["-C", repository] : ["--git-dir", mirror];
    const commit = command("git", [...source, "rev-parse", "--verify", `${ref}^{commit}`]);
    if (commit.status !== 0) fail(`cannot resolve abbreviated source ${ref}; provide an unambiguous full commit or remote ref: ${commit.stderr}`);
    resolved = commit.stdout;
  }
  const sourceRef = sourceRefFor(repository, ref);
  const bases = existsSync(repository) ? importBaseCommits(repository, resolved, mirror) : [];
  // Negotiate only independently complete ancestry; damaged/unknown custody needs full refetch.
  const negotiation = bases.length ? bases.map(tip => `--negotiation-tip=${tip}`) : ["--refetch"];
  run("git", ["--git-dir", mirror, "fetch", ...negotiation, "--no-tags", "--no-auto-maintenance", "workspace-source", `+${resolved}:${sourceRef}`], { timeout: sourcePreparationMode === "worker" ? 1_800_000 : 120_000 });
  const commit = run("git", ["--git-dir", mirror, "rev-parse", "--verify", `${sourceRef}^{commit}`]);
  if (!hasObjectClosure(mirror, commit, sparsePatterns)) fail(`fetched source has incomplete object closure: ${commit}`);
  return commit;
}

// Clone uses a temporary source remote, so Git does not create origin's fetch mapping.
// Install it before materialization, and repair older interrupted clones at either exit.
// Preserve explicit caller mappings and never invent a published remote-tracking ref.
function ensureOriginFetch(destination) {
  const current = command("git", ["-C", destination, "config", "--local", "--get-all", "remote.origin.fetch"]);
  if (current.status === 0 && current.stdout.length > 0) return;
  if (current.status !== 0 && current.status !== 1) fail(`cannot read origin fetch configuration: ${current.stderr || current.error?.message}`);
  git(destination, ["config", "--local", "--replace-all", "remote.origin.fetch", ORIGIN_FETCH_REFSPEC]);
}

function cloneSourceTag(statePath, mirror, sourceCommit) {
  const name = `pi-workspace-source-${sourceCommit}`;
  const ref = `refs/tags/${name}`;
  const read = () => command("git", ["--git-dir", mirror, "rev-parse", "--verify", ref]);
  const existing = read();
  if (existing.status === 0 && existing.stdout === sourceCommit) return name;
  return withResourceLock(statePath, `mirror:${mirror}`, () => {
    const current = read();
    if (current.status === 0 && current.stdout !== sourceCommit) fail(`clone source custody differs at ${ref}`);
    if (current.status !== 0) run("git", ["--git-dir", mirror, "update-ref", ref, sourceCommit, ""]);
    return name;
  });
}

function prepareSharedSourceClone(destination, repository, sourceCommit, input, mirror) {
  const objectSource = path.join(mirror, "objects");
  if (!existsSync(path.join(destination, ".git"))) {
    if (existsSync(destination) && readdirSync(destination).length !== 0) fail("pending shared-source directory has non-Git files");
    run("git", ["init", "-b", input.branch, destination]);
  }
  const rawDirectory = git(destination, ["rev-parse", "--absolute-git-dir"]);
  if (rawDirectory !== path.join(destination, ".git")) fail("pending shared source is not an independent clone");
  const alternates = path.join(rawDirectory, "objects", "info", "alternates");
  if (existsSync(alternates) && readFileSync(alternates, "utf8") !== `${objectSource}\n`) {
    fail("pending shared source object store differs; use maintain --path with --execute to import its current refs before resuming");
  }
  const head = command("git", ["-C", destination, "rev-parse", "--verify", "HEAD"]);
  if (head.status !== 0 && (existsSync(path.join(rawDirectory, "index")) || readdirSync(destination).some(name => name !== ".git"))) {
    fail("pending shared source lacks HEAD but contains materialized work; preserve it for repair");
  }
  const readOrigin = command("git", ["-C", destination, "config", "--local", "--get", "remote.origin.url"]);
  if (![0, 1].includes(readOrigin.status)) fail("cannot inspect pending shared source origin");
  const origin = readOrigin.status === 1 ? null : readOrigin.stdout;
  if (head.status !== 0 && git(destination, ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean)
    .some(name => name !== `refs/tags/pi-workspace-source-${sourceCommit}`)) fail("pending shared source lacks HEAD but has other source refs; preserve it for repair");
  if (origin !== null && origin !== repository) {
    if (head.status !== 0) fail("pending shared source origin differs");
    return;
  }
  if (!existsSync(alternates)) writeFileSync(alternates, `${objectSource}\n`);
  if (origin === null) git(destination, ["remote", "add", "origin", repository]);
  ensureOriginFetch(destination);
  for (const [name, value] of Object.entries({ ...REFERENCE_CLONE_CONFIG, "core.hooksPath": "/dev/null", "submodule.recurse": "false" })) {
    git(destination, ["config", "--local", name, value]);
  }
  const custodyRef = `refs/tags/pi-workspace-source-${sourceCommit}`;
  const custody = command("git", ["-C", destination, "rev-parse", "--verify", custodyRef]);
  if (custody.status === 0 && custody.stdout !== sourceCommit) fail("pending shared source custody tag differs");
  if (custody.status !== 0) git(destination, ["update-ref", custodyRef, sourceCommit, ""]);
  if (head.status !== 0) git(destination, ["update-ref", "--no-deref", "HEAD", sourceCommit]);
}

function prepareSourceValue(database, args, request) {
  const { statePath, root, destination, repository, upstream, mirror, intent, sparsePatterns, sourceCommit } = request;
  if (sourceJobDirectory !== null) writeSourceJobProgress(sourceJobDirectory, { phase: "forecasting", commit: sourceCommit });
  const blockSize = statfsSync(root).bsize;
  const forecastPath = `${request.receipt}.forecast.json`;
  const inputs = { version: 4, repository, sourceCommit, intent, sparsePatterns, blockSize, stamp: objectStoreStamp(mirror) };
  const cached = existsSync(forecastPath) ? JSON.parse(readFileSync(forecastPath, "utf8")) : null;
  const fingerprint = sourceJobId("source-forecast", inputs);
  let plan = cached !== null && cached.fingerprint === fingerprint ? cached.plan : intent === null
    ? { intent: "unestimated", estimate: "unknown", constructionBytes: Math.ceil(numberFlag(args, "min-free-gib", DEFAULT_MIN_FREE_GIB) * 1024 ** 3), growthBytes: 0, headroomBytes: 0 }
    : sourceCapacityPlan(repository, sourceCommit, intent, blockSize, mirror, sparsePatterns);
  if (cached !== null && cached.fingerprint === fingerprint && intent !== null) {
    assertSourceCheckoutFilters(existsSync(repository) ? repository : mirror);
  }
  const forecast = { inputs, fingerprint, plan };
  writePreparationReceipt(forecastPath, forecast);
  const device = String(statSync(root).dev);
  let resolvedCommit;
  withResourceLock(statePath, `capacity:${device}`, () => {
    try { plan.admission = assertCapacity(root, args, database, destination, plan); }
    catch (error) {
      if (error.code === "workspace-capacity-refused") writePreparationReceipt(forecastPath,
        { ...forecast, refusal: { code: error.code, capacity: error.capacity } });
      throw error;
    }
    resolvedCommit = resolveSource(statePath, mirror, repository, upstream, sourceCommit, sparsePatterns);
    if (!resolvedCommit.startsWith(sourceCommit)) fail("source preparation changed the requested commit");
  });
  return { sourceCommit: resolvedCommit, plan, stamp: objectStoreStamp(mirror) };
}

function prepareCreationSource(database, args, input) {
  let sourceCommit = resolveRequestedSource(input.repository, input.ref);
  if (input.intent !== null && !/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    const resolved = command("git", ["--git-dir", input.mirror, "rev-parse", "--verify", `${sourceCommit}^{commit}`]);
    if (resolved.status !== 0) fail("source capacity estimate unknown: remote commit is absent from durable mirror custody; remote import remains unestimated");
    sourceCommit = resolved.stdout;
  }
  const request = { ...input, sourceCommit, args: [...args.named], capacityPricingVersion: 4 };
  const key = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const directory = path.join(path.dirname(input.statePath), "source-preparations");
  const receipt = path.join(directory, `${key}.json`);
  const stamp = objectStoreStamp(input.mirror);
  if (stamp !== null && existsSync(receipt)) {
    const value = JSON.parse(readFileSync(receipt, "utf8"));
    if (value.sourceCommit === sourceCommit && value.stamp === stamp) return { state: "ready", value };
  }
  const pointerPath = path.join(directory, `${key}.job.json`);
  let pointer = existsSync(pointerPath) ? JSON.parse(readFileSync(pointerPath, "utf8")) : null;
  const observeJob = () => runSourceJob({ directory: path.join(directory, "jobs"), key,
    request: { ...request, initialStamp: pointer.initialStamp, receipt, ...(pointer.recovery ? { recovery: pointer.recovery } : {}) },
    command: [process.execPath, new URL(import.meta.url).pathname, "source-prepare"], env: {}, waitMs: 2000, restartInterrupted: true });
  const accepted = job => {
    if (job.jobId && pointer.jobId !== job.jobId) writePreparationReceipt(pointerPath, { ...pointer, jobId: job.jobId });
    if (job.state === "failed" || job.state === "interrupted") fail(`source preparation ${job.state}: ${job.error?.code}: ${job.error?.message}; job ${pointer.jobId}; progress ${job.progressPath ?? path.join(directory, "jobs", pointer.jobId, "progress.json")}`);
    return job;
  };
  if (pointer !== null && !pointer.jobId) {
    pointer = { ...pointer, jobId: sourceJobId(key, { ...request, initialStamp: pointer.initialStamp, receipt,
      ...(pointer.recovery ? { recovery: pointer.recovery } : {}) }) };
    writePreparationReceipt(pointerPath, pointer);
  }
  if (pointer !== null && pointer.jobId) {
    const terminalPath = path.join(directory, "jobs", pointer.jobId, "result.json");
    if (!existsSync(terminalPath)) return accepted(observeJob());
    const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
    if (terminal.state !== "ready") {
      const stats = statfsSync(input.root);
      const observation = { observedAt: Date.now(), device: String(statSync(input.root).dev),
        freeBytes: stats.bavail * stats.bsize, freeInodes: stats.ffree, totalInodes: stats.files };
      const recovery = capacityRecovery(terminal, pointer.jobId, observation);
      if (recovery.state === "invalid") fail(`${recovery.error.code}: ${recovery.error.message}`);
      if (recovery.state !== "retry") return accepted(observeJob());
      try {
        sourcePreparationMode = "foreground";
        sourcePreparationDeadline = Date.now() + 1500;
        const fresh = prepareSourceValue(database, args, { ...request, receipt });
        recovery.value.admission = fresh.plan.admission;
      } catch (error) {
        if (!(error instanceof SourcePreparationRequired)) throw error;
      } finally {
        sourcePreparationMode = null;
        sourcePreparationDeadline = Infinity;
      }
      const previous = pointer;
      pointer = { initialStamp: objectStoreStamp(input.mirror), recovery: recovery.value };
      writePreparationReceipt(path.join(directory, "recoveries", `${recovery.value.id}.json`), { previous, next: pointer });
      writePreparationReceipt(pointerPath, pointer);
    }
    if (terminal.state === "ready" && terminal.value.stamp !== stamp) pointer = null;
  }
  let value;
  try {
    sourcePreparationMode = "foreground";
    sourcePreparationDeadline = Date.now() + 1500;
    if (!pointer?.recovery) value = prepareSourceValue(database, args, { ...request, receipt });
  } catch (error) {
    if (!(error instanceof SourcePreparationRequired)) throw error;
  } finally {
    sourcePreparationMode = null;
    sourcePreparationDeadline = Infinity;
  }
  if (value !== undefined) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writePreparationReceipt(receipt, value);
    return { state: "ready", value };
  }
  if (pointer === null) {
    pointer = { initialStamp: stamp };
    writePreparationReceipt(pointerPath, pointer);
  }
  const jobRequest = { ...request, initialStamp: pointer.initialStamp, receipt,
    ...(pointer.recovery ? { recovery: pointer.recovery } : {}) };
  pointer = { ...pointer, jobId: sourceJobId(key, jobRequest) };
  writePreparationReceipt(pointerPath, pointer);
  const job = accepted(observeJob());
  if (job.state === "ready" && job.value.stamp !== objectStoreStamp(input.mirror)) fail("source changed during preparation; repeat the original request");
  return job;
}

function writePreparationReceipt(file, value) {
  const temporary = `${file}.${randomUUID()}`;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, file);
}

function sourcePreparationWorker() {
  const directory = process.env.PI_WORKSPACE_SOURCE_JOB_DIR;
  const loaded = readSourceJobRequest(directory);
  if (!loaded.ok) fail(loaded.error.message);
  const request = loaded.value;
  const database = openRegistry(request.statePath);
  sourcePreparationMode = "worker";
  sourceJobDirectory = directory;
  try {
    const value = prepareSourceValue(database, { named: new Map(request.args), positional: [] }, request);
    writePreparationReceipt(request.receipt, value);
    const result = finishSourceJob(directory, { state: "ready", value });
    if (!result.ok) fail(result.error.message);
  } catch (error) {
    finishSourceJob(directory, { state: "failed", error: { code: error.code === "workspace-capacity-refused" ? error.code : "source-preparation-failed", message: error.message } });
    throw error;
  } finally { database.close(); }
}

function creationRequest(args, repository) {
  const name = safeName(required(args, "name"));
  const sparsePatterns = many(args, "sparse-pattern");
  const intent = capacityIntent(args);
  return JSON.stringify({ repository, ref: one(args, "ref", "HEAD"), mode: one(args, "mode", "writer"),
    strategy: one(args, "strategy", "clone"), branch: one(args, "branch", `agent/${name}`),
    owner: one(args, "owner", name), kind: one(args, "kind", "agent"), groupId: one(args, "group", null),
    cachePaths: normalizeCachePaths(many(args, "cache")),
    ...(sparsePatterns.length ? { sparsePatterns } : {}), ...(intent === null ? {} : { capacity: intent }),
    leaseSeconds: numberFlag(args, "lease-seconds", DEFAULT_LEASE_SECONDS) });
}

function createCommand(database, args, statePath) {
  assertOnly(args, ["root", "name", "repo", "ref", "branch", "kind", "mode", "owner", "group", "strategy", "lease-seconds", "cache", "max-count", "min-free-gib", "min-free-inodes-percent", "creation-timeout-seconds", "sparse-pattern", "intent", "headroom-gib", "growth-mib", "json"]);
  const destination = path.join(path.resolve(required(args, "root")), safeName(required(args, "name")));
  const pending = database.prepare("SELECT id,creation_request FROM workspace WHERE path=? AND state='creating'").get(destination);
  if (pending && process.env.PI_WORKSPACE_CHECKOUT_JOB !== pending.id) {
    const request = creationRequest(args, repositoryLocation(required(args, "repo"), currentDirectory()));
    if (request !== pending.creation_request) fail(`workspace already exists with a different creation request: ${destination}`);
    const directory = path.join(path.dirname(statePath), "checkout-jobs", pending.id);
    if (existsSync(directory)) for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const job = path.join(directory, entry.name);
      if (existsSync(path.join(job, "result.json")) || !existsSync(path.join(job, "attempt.json"))) continue;
      const attempt = JSON.parse(readFileSync(path.join(job, "attempt.json"), "utf8"));
      const active = command("systemctl", ["--user", "show", attempt.unit, "--property=ActiveState", "--value"], { timeout: 2500 });
      if (active.status === 0 && ["active", "activating", "deactivating"].includes(active.stdout)) {
        print({ ok: true, state: "creating", id: pending.id, path: destination,
          jobId: entry.name, jobKind: "checkout", progressPath: path.join(job, "progress.json"),
          observeCommand: jobObserveCommand(entry.name),
          nextAction: "Use job-status for read-only checkout observation; repeat create only to recover interrupted or failed work" }, true);
        process.exitCode = 75;
        return;
      }
    }
  }
  return withWorkspaceLock(database, destination, () => createWorkspace(database, args, statePath), one(args, "group"));
}

function createWorkspace(database, args, statePath) {
  const intent = capacityIntent(args);
  const checkoutTimeout = creationTimeout(args);
  const root = path.resolve(required(args, "root"));
  const name = safeName(required(args, "name"));
  const destination = path.join(root, name);
  const repository = repositoryLocation(required(args, "repo"), currentDirectory());
  const ref = one(args, "ref", "HEAD");
  const mode = one(args, "mode", "writer");
  if (!["writer", "review"].includes(mode)) fail("--mode must be writer or review");
  const strategy = one(args, "strategy", "clone");
  if (!["clone", "worktree"].includes(strategy)) fail("--strategy must be clone or worktree");
  if (intent !== null && strategy !== "clone") fail("budgeted intent requires a shared-object clone; worktree capacity is unestimated");
  const sparsePatterns = many(args, "sparse-pattern");
  if (sparsePatterns.some(pattern => !pattern.trim() || pattern === "true" || /[\r\n\0]/u.test(pattern))) {
    fail("--sparse-pattern requires a nonempty single-line Git non-cone pattern");
  }
  if (sparsePatterns.length && strategy !== "clone") fail("--sparse-pattern currently requires --strategy clone");
  const branch = one(args, "branch", `agent/${name}`);
  const request = creationRequest(args, repository);
  const input = JSON.parse(request);
  const upstream = repositoryRemotes(repository);
  const mirror = mirrorFor(statePath, intent === null ? repository : upstream.fetch);
  let row = database.prepare("SELECT * FROM workspace WHERE path = ?").get(destination);
  if (row !== undefined && recordRetainsCustody(database, row.id)) growthError("growth-admission-required", "retained growth requires fresh resume-growth admission");
  if (row !== undefined && row.state !== "released") {
    if (row.creation_request !== request) fail(`workspace already exists with a different creation request: ${destination}${row.state === "creating" ? "; resume the original request, or use cancel-creation if its destination is absent" : ""}`);
    if (row.state === "active" && existsSync(destination)) {
      print(creationRecord(database, row.id), bool(args, "json"));
      return;
    }
    if (row.state !== "creating") fail(`workspace cannot resume creation from state ${row.state}: ${destination}`);
  } else {
    if (existsSync(destination)) fail(`workspace already exists: ${destination}`);
    mkdirSync(root, { recursive: true });
    const preparation = withResourceLock(statePath, `source-preparation:${destination}`, () =>
      prepareCreationSource(database, args, { statePath, root, destination, repository, ref, upstream, mirror, intent, sparsePatterns }));
    if (preparation.state !== "ready") {
      print({ ok: true, state: "preparing", jobKind: "source", jobId: preparation.jobId, progressPath: preparation.progressPath, resultPath: preparation.resultPath,
        observeCommand: `agent-workspace source-status --job-id ${preparation.jobId} --json`,
        nextAction: "Use source-status for authoritative terminal observation; repeat this exact create request to continue admission" }, true);
      process.exitCode = 75;
      return;
    }
    const { sourceCommit, plan } = preparation.value;
    const device = String(statSync(root).dev);
    withResourceLock(statePath, `capacity:${device}`, () => {
      plan.admission = assertCapacity(root, args, database, destination, plan);
      database.exec("BEGIN IMMEDIATE");
      try {
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
        const reserved = database.prepare("SELECT id, creation_request FROM workspace WHERE path=?").get(destination);
        if (reserved.creation_request !== request) fail(`workspace creation was claimed by another request: ${destination}`);
        database.prepare("INSERT OR REPLACE INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)")
          .run(reserved.id, device, JSON.stringify(plan));
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
    row = database.prepare("SELECT * FROM workspace WHERE path = ?").get(destination);
    if (row.creation_request !== request) fail(`workspace creation was claimed by another request: ${destination}`);
  }
  let sourceCommit = row.source_commit;
  if (database.prepare("SELECT 1 FROM workspace_capacity WHERE workspace_id=?").get(row.id) === undefined) {
    mkdirSync(root, { recursive: true });
    if (intent !== null && sourceCommit === null) fail("budgeted pending creation has no immutable source custody");
    const plan = intent === null
      ? { intent: "unestimated", estimate: "unknown", constructionBytes: Math.ceil(numberFlag(args, "min-free-gib", DEFAULT_MIN_FREE_GIB) * 1024 ** 3), growthBytes: 0, headroomBytes: 0 }
      : sourceCapacityPlan(repository, sourceCommit, intent, statfsSync(root).bsize, mirror, sparsePatterns);
    const device = String(statSync(root).dev);
    withResourceLock(statePath, `capacity:${device}`, () => {
      plan.admission = assertCapacity(root, args, database, destination, plan);
      database.prepare("INSERT INTO workspace_capacity(workspace_id,device_id,plan_json) VALUES(?,?,?)")
        .run(row.id, device, JSON.stringify(plan));
    });
  }
  if (sourceCommit === null) {
    sourceCommit = resolveSource(statePath, mirror, repository, upstream, ref, sparsePatterns);
    database.prepare("UPDATE workspace SET source_commit=?, updated_at=? WHERE id=?")
      .run(sourceCommit, Date.now(), row.id);
  }
  if (intent !== null) resolveSource(statePath, mirror, repository, upstream, sourceCommit, sparsePatterns);
  const staged = strategy === "clone" && !existsSync(destination);
  const staging = process.env.PI_WORKSPACE_CHECKOUT_JOB === row.id
    ? process.env.PI_WORKSPACE_CHECKOUT_STAGE
    : path.join(root, `.${name}.creating-${row.id}`);
  if (staged && process.env.PI_WORKSPACE_CHECKOUT_JOB !== row.id) {
    if (!args.named.has("creation-timeout-seconds")) {
      const fileCount = git(mirror, ["ls-tree", "-r", "--name-only", "-z", sourceCommit]).split("\0").filter(Boolean).length;
      const plan = JSON.parse(database.prepare("SELECT plan_json FROM workspace_capacity WHERE workspace_id=?").get(row.id).plan_json);
      const bytes = plan.intent === "unestimated" ? 0 : plan.constructionBytes;
      args.named.set("creation-timeout-seconds", [String(Math.min(86400,
        Math.max(DEFAULT_CREATION_TIMEOUT_SECONDS, Math.ceil(60 + fileCount / 100 + bytes / (8 * 1024 ** 2)))))]);
    }
    const jobBudget = creationTimeout(args);
    const normalized = [...args.named].flatMap(([flag, values]) => values.map(value => `--${flag}=${value}`));
    const jobDirectory = path.join(path.dirname(statePath), "checkout-jobs", row.id);
    mkdirSync(jobDirectory, { recursive: true, mode: 0o700 });
    const generationFile = path.join(jobDirectory, "generation");
    const generation = existsSync(generationFile) ? Number(readFileSync(generationFile, "utf8")) : 0;
    if (!Number.isSafeInteger(generation) || generation < 0) fail("invalid checkout job generation");
    const candidate = `${staging}-${generation}-${jobBudget}`;
    const job = runSourceJob({
      directory: jobDirectory,
      key: `checkout:${row.id}:${jobBudget}:${generation}`, request: { id: row.id, sourceCommit, request },
      command: [process.execPath, new URL("checkout-job.mjs", import.meta.url).pathname,
        statePath, row.id, candidate, String(jobBudget), ...normalized],
      waitMs: 0, restartInterrupted: true, restartAbnormal: true,
      cleanupCommand: [process.execPath, new URL("checkout-job.mjs", import.meta.url).pathname, "--cleanup", candidate],
    });
    if (job.state === "ready") {
      print(creationRecord(database, row.id), bool(args, "json"));
      return;
    }
    if (job.state === "failed") {
      const next = `${generationFile}.tmp`;
      writeFileSync(next, String(generation + 1), { mode: 0o600 });
      renameSync(next, generationFile);
      database.prepare("UPDATE workspace SET detail=?,updated_at=? WHERE id=? AND state='creating'")
        .run(`checkout failed; private staging cleaned: ${job.error.message}`, Date.now(), row.id);
      fail(`checkout failed (${job.error.code}): ${job.error.message}; repeat the same create request to retry`);
    }
    print({ ok: true, state: "creating", id: row.id, path: destination,
      jobId: job.jobId, jobKind: "checkout", progressPath: job.progressPath,
      observeCommand: jobObserveCommand(job.jobId),
      nextAction: "Use job-status for read-only checkout observation; repeat create only to recover interrupted or failed work" }, true);
    process.exitCode = 75;
    return;
  }
  const materialization = staged ? staging : destination;
  if (staged) rmSync(staging, { recursive: true, force: true });
  try {
    if (!existsSync(materialization) || readdirSync(materialization).length === 0) {
      const plan = database.prepare("SELECT plan_json FROM workspace_capacity WHERE workspace_id=?").get(row.id);
      assertCapacity(root, args, database, destination, plan === undefined ? undefined : JSON.parse(plan.plan_json));
      if (strategy === "worktree") {
        const worktreeArgs = ["--git-dir", mirror, "worktree", "add"];
        if (mode === "review") worktreeArgs.push("--detach", destination, sourceCommit);
        else worktreeArgs.push("-b", branch, destination, sourceCommit);
        run("git", worktreeArgs, { timeout: checkoutTimeout });
      } else if (intent !== null) {
        prepareSharedSourceClone(materialization, repository, sourceCommit, input, mirror);
      } else {
        const sourceTag = cloneSourceTag(statePath, mirror, sourceCommit);
        run("git", ["clone", "--no-local", ...Object.entries(REFERENCE_CLONE_CONFIG)
          .flatMap(([name, value]) => ["--config", `${name}=${value}`]),
          "--config", `remote.origin.url=${repository}`, "--config", `remote.origin.fetch=${ORIGIN_FETCH_REFSPEC}`,
          "--origin", "workspace-source",
          "--reference-if-able", mirror, "--no-checkout", "--no-tags", "--single-branch", "--branch", sourceTag,
          mirror, materialization], { timeout: checkoutTimeout });
      }
    }
    if (intent !== null) prepareSharedSourceClone(materialization, repository, sourceCommit, input, mirror);
    const info = gitInfo(materialization);
    if (info.checkoutType !== strategy) fail("pending checkout type changed");
    if (strategy === "clone") {
      prepareSparseCheckout(materialization, input);
      resumeCloneCheckout(materialization, input, sourceCommit, upstream, checkoutTimeout);
    }
    const head = git(materialization, ["rev-parse", "HEAD"]);
    const selectedBranch = command("git", ["-C", materialization, "symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (head !== sourceCommit || (mode === "writer" ? selectedBranch.stdout !== branch : selectedBranch.status === 0)) {
      fail("pending checkout HEAD or branch differs from the reserved source");
    }
    assertPendingClean(materialization);
    if (strategy === "clone") {
      git(materialization, ["remote", "set-url", "origin", upstream.fetch]);
      ensureOriginFetch(materialization);
      configurePushUrl(["-C", materialization], upstream);
      const cloneSource = command("git", ["-C", materialization, "config", "--local", "--get", "remote.workspace-source.url"]);
      if (cloneSource.status === 0 && cloneSource.stdout === mirror) git(materialization, ["remote", "remove", "workspace-source"]);
      maintainReferenceClone(materialization, true, statePath);
    }
    if (staged) {
      try {
        lstatSync(destination);
        fail("checkout destination appeared during materialization; candidate not published");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      renameSync(staging, destination);
    }
    completeCreation(database, row.id, upstream.fetch, input.leaseSeconds, "creation completed", args);
  } catch (error) {
    if (staged) rmSync(staging, { recursive: true, force: true });
    database.prepare("UPDATE workspace SET detail=?, updated_at=? WHERE id=? AND state='creating'")
      .run(`${staged ? "creation failed; private staging removed" : "creation retained"}: ${error.message}`, Date.now(), row.id);
    throw error;
  }
}

// Write the selection before the first worktree checkout: no large excluded blob is opened.
// Retrying must not silently overwrite a caller's changed sparse selection or existing index.
function prepareSparseCheckout(destination, input) {
  if (!input.sparsePatterns?.length) return;
  const file = path.join(destination, ".git", "info", "sparse-checkout");
  const content = `${input.sparsePatterns.join("\n")}\n`;
  if (existsSync(file)) {
    if (readFileSync(file, "utf8") !== content) fail("pending sparse selection differs; preserve and repair it before resuming creation");
  } else {
    if (git(destination, ["ls-files", "--stage"])) fail("pending sparse checkout has an index but no recorded selection; preserve and repair it before resuming creation");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, { flag: "wx", mode: 0o600 });
  }
  git(destination, ["config", "--local", "core.sparseCheckout", "true"]);
  git(destination, ["config", "--local", "core.sparseCheckoutCone", "false"]);
}

function resumeCloneCheckout(destination, input, sourceCommit, upstream, checkoutTimeout) {
  const head = git(destination, ["rev-parse", "HEAD"]);
  const selected = command("git", ["-C", destination, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  const correctBranch = input.mode === "review" ? selected.status !== 0 : selected.stdout === input.branch;
  const refuse = reason => fail(`pending checkout cannot resume: ${reason}; preserve and repair it before resuming creation`);
  const origin = repositoryLocation(git(destination, ["config", "--local", "--get", "remote.origin.url"]), destination);
  if (![input.repository, upstream.fetch].includes(origin)) refuse("origin differs from the creation request");
  ensureOriginFetch(destination);
  if (head === sourceCommit && correctBranch && existsSync(path.join(destination, ".git", "index"))) return;
  const unique = git(destination, ["rev-list", "--branches", "HEAD", "--not", "--remotes", sourceCommit]);
  if (unique) refuse("commits absent from remote refs and reserved source");
  const branch = command("git", ["-C", destination, "rev-parse", "--verify", `refs/heads/${input.branch}`]);
  if (input.mode === "writer" && branch.status === 0 && branch.stdout !== sourceCommit) {
    refuse("reserved branch has different source");
  }
  const entries = git(destination, ["ls-tree", "-rz", sourceCommit]).split("\0").filter(Boolean);
  const tree = new Map(entries.map(entry => {
    const [metadata, name] = entry.split(/\t(.*)/su);
    const [mode, type, object] = metadata.split(" ");
    return [name, { mode, type, object }];
  }));
  const index = git(destination, ["ls-files", "--stage", "-z"]).split("\0").filter(Boolean);
  // A killed first checkout leaves no index, or the completed reserved tree, never arbitrary staging.
  if (index.length && (index.length !== tree.size || index.some(entry => {
    const [metadata, name] = entry.split(/\t(.*)/su);
    const [mode, object, stage] = metadata.split(" ");
    const expected = tree.get(name);
    return stage !== "0" || expected?.mode !== mode || expected?.object !== object;
  }))) refuse("index differs from the reserved tree");
  const untracked = git(destination, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.split("\0").filter(Boolean).some(name => !tree.has(name))) {
    refuse("untracked files are not creation leftovers");
  }
  const algorithm = git(destination, ["rev-parse", "--show-object-format"]);
  const directories = new Set();
  for (const [name, expected] of tree) {
    const components = name.split("/");
    for (let length = 1; length < components.length; length++) {
      const parent = components.slice(0, length).join("/");
      if (directories.has(parent)) continue;
      directories.add(parent);
      try {
        if (!lstatSync(path.join(destination, parent)).isDirectory()) refuse(`non-directory at ${parent}`);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const file = path.join(destination, name);
    let stat;
    try { stat = lstatSync(file); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (expected.type !== "blob" || (expected.mode === "120000" ? !stat.isSymbolicLink() : !stat.isFile())) {
      refuse(`file type differs at ${name}`);
    }
    const bytes = expected.mode === "120000" ? readlinkSync(file, { encoding: "buffer" }) : readFileSync(file);
    const object = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (object !== expected.object || (expected.mode !== "120000"
      && Boolean(stat.mode & 0o111) !== (expected.mode === "100755"))) {
      refuse(`file differs from the reserved tree at ${name}`);
    }
  }
  git(destination, input.mode === "review"
    ? ["checkout", "--force", "--detach", sourceCommit]
    : ["checkout", "--force", "-B", input.branch, sourceCommit], { timeout: checkoutTimeout });
}

function assertPendingClean(destination) {
  const changes = git(destination, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (changes) fail(`pending checkout contains changes: ${changes.split("\n").slice(0, 8).join(" | ")}; preserve and repair them before resuming creation`);
}

function recordedCapacity(database, id) {
  const row = database.prepare("SELECT plan_json FROM workspace_capacity WHERE workspace_id=?").get(id);
  return row === undefined ? null : JSON.parse(row.plan_json);
}

function creationRecord(database, id) {
  return { ...recordBy(database, { id }), capacity: recordedCapacity(database, id) };
}

function completeCreation(database, id, repository, leaseSeconds, detail, args) {
  const row = database.prepare("SELECT w.path, c.device_id, c.plan_json FROM workspace w JOIN workspace_capacity c ON c.workspace_id=w.id WHERE w.id=? AND w.state='creating'").get(id);
  let plan;
  if (row !== undefined) {
    plan = JSON.parse(row.plan_json);
    const measurement = workspaceAllocationSample(row.path, row.device_id);
    database.prepare("INSERT OR REPLACE INTO workspace_capacity_measurement(workspace_id,measurement_json) VALUES(?,?)").run(id, JSON.stringify(measurement));
    if (measurement.ok) plan.completedAllocationBytes = measurement.allocatedBytes;
    else {
      plan.completedAllocationBytes = null;
      plan.completedAllocationError = measurement.error;
      process.stderr.write(`capacity baseline unavailable at ${row.path}; retaining full growth reservation: ${measurement.error}\n`);
    }
  }
  const now = Date.now();
  database.exec("BEGIN IMMEDIATE");
  try {
    if (plan !== undefined) database.prepare("UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=?").run(JSON.stringify(plan), id);
    database.prepare("UPDATE workspace SET repository=?, state='active', detail=?, updated_at=?, lease_expires_at=? WHERE id=? AND state='creating'")
      .run(repository, detail, now, now + leaseSeconds * 1000, id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  print(creationRecord(database, id), bool(args, "json"));
}

function finalizeCreationCommand(database, args, statePath) {
  assertOnly(args, ["id", "path", "json"]);
  const record = recordBy(database, selectorFrom(args));
  if (record.state === "active") {
    print(creationRecord(database, record.id), bool(args, "json"));
    return;
  }
  if (record.state !== "creating") fail(`workspace cannot finalize creation from state ${record.state}`);
  if (record.sourceCommit === null) fail("pending creation has no recorded source commit; repeat the original create command first");
  const input = record.creation;
  const info = gitInfo(record.path);
  if (info.checkoutType !== input.strategy) fail("pending checkout type changed");
  if (info.checkoutType === "worktree") {
    const common = path.resolve(record.path, git(record.path, ["rev-parse", "--git-common-dir"]));
    if (realpathSync(common) !== realpathSync(mirrorFor(statePath, input.repository))) fail("pending worktree has a different source mirror");
  } else {
    const upstream = repositoryRemotes(input.repository);
    const origin = git(record.path, ["config", "--local", "--get", "remote.origin.url"]);
    if (![input.repository, upstream.fetch].includes(repositoryLocation(origin, record.path))) {
      fail("pending checkout origin differs from the creation request");
    }
  }
  const ancestry = command("git", ["-C", record.path, "merge-base", "--is-ancestor", record.sourceCommit, info.head]);
  if (ancestry.status !== 0) fail("pending checkout HEAD is not descended from the recorded source commit");
  const branch = command("git", ["-C", record.path, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (input.mode === "writer" ? branch.status !== 0 : branch.status === 0) fail("pending checkout branch mode differs from the creation request; repeat the original create command for an untouched checkout, or restore the intended branch and clean index before finalize-creation; no files have been removed");
  assertPendingClean(record.path);
  if (info.checkoutType === "clone") {
    ensureOriginFetch(record.path);
    maintainReferenceClone(record.path, true, statePath);
  }
  completeCreation(database, record.id, info.repository ?? record.repository, input.leaseSeconds,
    "creation finalized; existing HEAD, branches, remotes and ignored output preserved; origin fetch mapping verified", args);
}

function cancelCreationCommand(database, args) {
  assertOnly(args, ["id", "path", "json"]);
  const record = recordBy(database, selectorFrom(args));
  if (record.state !== "creating") fail(`workspace cannot cancel creation from state ${record.state}`);
  const statePath = registryPaths.get(database);
  const jobs = path.join(path.dirname(statePath), "checkout-jobs", record.id);
  if (existsSync(jobs)) for (const entry of readdirSync(jobs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const attemptFile = path.join(jobs, entry.name, "attempt.json");
    if (!existsSync(attemptFile)) continue;
    const attempt = JSON.parse(readFileSync(attemptFile, "utf8"));
    const observed = command("systemctl", ["--user", "show", attempt.unit, "--property=ActiveState", "--value"]);
    if (observed.status !== 0 || !["inactive", "failed"].includes(observed.stdout)) {
      fail("pending checkout has a durable job still running or stopping; repeat create to observe completion before cancellation");
    }
  }
  // lstat also protects dangling symlinks. Cancellation never removes filesystem entries.
  try {
    lstatSync(record.path);
    fail(`pending checkout exists; repeat the original create command or use finalize-creation for a clean descendant checkout: ${record.path}`);
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
  for (const candidate of records) assertGrowthWritable(database,candidate);
  const statement = database.prepare("UPDATE workspace SET lease_expires_at = ?, updated_at = ?, state = 'active', detail = 'lease renewed' WHERE id = ?");
  for (const candidate of records) statement.run(expires, now, candidate.id);
  const renewed = records.map((candidate) => recordBy(database, { id: candidate.id }));
  print(renewed.length === 1 ? renewed[0] : renewed, bool(args, "json"));
}

function generatedOnlySourceCustody(database, id) {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_generated_retirement'").get()) return false;
  return database.prepare("SELECT 1 FROM workspace_generated_retirement WHERE workspace_id=?").get(id) !== undefined;
}
function generatedRetirementPending(database, id) {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_generated_retirement'").get()) return false;
  return database.prepare("SELECT 1 FROM workspace_generated_retirement WHERE workspace_id=? AND json_extract(journal_json,'$.state')='pending'").get(id) !== undefined;
}
function recordRetainsCustody(database, id) {
  if (generatedRetirementPending(database, id)) return true;
  const row = database.prepare("SELECT plan_json FROM workspace_capacity WHERE workspace_id=?").get(id);
  return row !== undefined && retainedGrowth(JSON.parse(row.plan_json));
}
function retainedParent(database, workspacePath) {
  if (!existsSync(workspacePath)) return false;
  const common = path.resolve(workspacePath, git(workspacePath,["rev-parse","--git-common-dir"]));
  if (common === path.join(workspacePath,".git")) return false;
  const parent = database.prepare("SELECT id FROM workspace WHERE path=?").get(path.dirname(common));
  return parent !== undefined && recordRetainsCustody(database,parent.id);
}
function assertGrowthWritable(database, record) {
  if (recordRetainsCustody(database,record.id) || retainedParent(database,record.path)) growthError("growth-admission-required", "workspace or shared Git parent retains custody; fresh resume-growth admission required");
}
function withGrowthBorrowerLocks(database,record,action,deadline) {
  const dependencies = gitDependencySnapshot(database);
  const ids = new Set([...dependencies.alternates.filter(value => value.recordId !== record.id && within(record.path,value.objectDirectory)),
    ...dependencies.linkedWorktrees.filter(value => value.recordId !== record.id && within(record.path,value.commonDirectory))].map(value => value.recordId));
  const borrowers = [...ids].sort().map(id => recordBy(database,{id}));
  const next = index => index === borrowers.length ? action() : withWorkspaceLock(database,borrowers[index].path,()=>next(index+1),borrowers[index].groupId,deadline);
  return next(0);
}
function retainedCustodyResult(record) {
  return {record, action:"none", inspection:{classification:"blocked", reason:"explicit retained source/runtime custody; resume-growth admission required before cleanup or writing", processes:[], containers:[], systemdUnits:[]}};
}

function terminalRetentionRelease(database, selected, args, statePath) {
  const owner = required(args, "owner");
  const expectedPlan = required(args, "expected-plan-sha256");
  const deadline = Date.now() + 25_000;
  return duringInspection(deadline, () => withWorkspaceLock(database, selected.path, () => {
    const record = recordBy(database, {id:selected.id});
    const row = database.prepare("SELECT plan_json FROM workspace_capacity WHERE workspace_id=?").get(record.id);
    if (!row || digest(row.plan_json) !== expectedPlan || record.owner !== owner) {
      growthError("stale-retention-release", "owner or capacity plan changed; read the current binding");
    }
    if (!retainedGrowth(JSON.parse(row.plan_json))) growthError("invalid-retention-release", "future growth is not retired");
    if (generatedOnlySourceCustody(database, record.id)) growthError("retention-release-source-custody", "separate generated/source materialization retention remains");
    if (record.groupId !== null) growthError("retention-release-group", "group retention requires an explicit disposition for every member");
    if (record.leaseExpiresAt !== 0) growthError("retention-release-active", "a writing lease remains");
    if (record.state === "released" && !existsSync(record.path)) {
      return {ok:true, record, action:"already-released", inspection:{classification:"missing", reason:"terminal retained release already completed", processes:[], containers:[], systemdUnits:[]}};
    }
    if (!["active", "referenced", "blocked", "repair-required", "reclaiming"].includes(record.state)) {
      growthError("invalid-retention-release", `cannot end retention from ${record.state}`);
    }
    if (retainedParent(database, record.path)) growthError("retention-release-parent", "shared Git parent still retains custody");
    const protect = inspection => ({ok:false, record:recordBy(database,{id:record.id}), action:"none", inspection,
      error:{code:"retention-release-protected", message:inspection.reason}});
    const observe = () => {
      if (existsSync(record.path)) {
        const safety = growthSafety(database, record);
        if (safety.errors.length || safety.references.length) return {classification:"blocked",
          reason:safety.errors.length ? `cannot prove terminal retention safety: ${safety.errors.join("; ")}` : "runtime/thread/process/borrower writing references remain",
          processes:safety.references, containers:[], systemdUnits:[]};
      }
      return inspectRecord(record, {ignoreLease:true, safety:safetySnapshot(database), deadline});
    };
    return withGrowthBorrowerLocks(database, record, () => {
      let inspection = observe();
      if (["referenced", "blocked", "active"].includes(inspection.classification) || inspection.sourceRetention) return protect(inspection);
      let removedCaches = [];
      if (inspection.classification === "repair-required") {
        removedCaches = stripCaches(record, statePath, () => database.prepare("DELETE FROM workspace_capacity_measurement WHERE workspace_id=?").run(record.id));
      }
      inspection = observe();
      if (!["reclaimable", "missing"].includes(inspection.classification)) return {...protect(inspection), removedCaches};
      if (Date.now() >= deadline) growthError("retention-release-timeout", "terminal retention safety budget exhausted");
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = recordBy(database, {id:record.id});
        const currentPlan = database.prepare("SELECT plan_json FROM workspace_capacity WHERE workspace_id=?").get(record.id);
        if (current.owner !== owner || current.leaseExpiresAt !== 0 || current.updatedAt !== record.updatedAt || currentPlan?.plan_json !== row.plan_json) {
          growthError("stale-retention-release", "record or plan changed before terminal release");
        }
        database.exec(`CREATE TABLE IF NOT EXISTS workspace_retention_release (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, occurred_at INTEGER NOT NULL,
          record_json TEXT NOT NULL, plan_json TEXT NOT NULL, inspection_json TEXT NOT NULL)`);
        database.prepare("INSERT INTO workspace_retention_release(workspace_id,occurred_at,record_json,plan_json,inspection_json) VALUES(?,?,?,?,?)")
          .run(record.id, Date.now(), JSON.stringify(record), row.plan_json, JSON.stringify(inspection));
        updateState(database, current, "reclaiming", "owner ended retained custody; terminal release qualified");
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
      if (inspection.classification !== "missing") removeWorkspace(record, statePath);
      removeEmptyWorkspaceContainer(record);
      updateState(database, record, "released", `owner ended retained custody: ${inspection.reason}`);
      return {ok:true, record:recordBy(database,{id:record.id}), action:"released", inspection, removedCaches};
    }, deadline);
  }, selected.groupId, deadline));
}

function releaseCommand(database, args, statePath) {
  assertOnly(args, ["id", "path", "reap-expired", "preserve-runtime", "json", "end-retention", "owner", "expected-plan-sha256"]);
  if (bool(args, "end-retention")) {
    if (bool(args, "reap-expired")) growthError("invalid-retention-release", "terminal retained release never stops runtime references");
    const result = terminalRetentionRelease(database, recordBy(database, selectorFrom(args)), args, statePath);
    print(result, bool(args, "json"));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (one(args, "owner") !== undefined || one(args, "expected-plan-sha256") !== undefined) {
    growthError("invalid-retention-release", "owner/plan binding requires explicit --end-retention");
  }
  const record = recordBy(database, selectorFrom(args));
  const records = recordsInGroup(database, record);
  if (records.some(candidate => generatedOnlySourceCustody(database, candidate.id) || recordRetainsCustody(database, candidate.id) || retainedParent(database,candidate.path))) {
    const results = records.map(retainedCustodyResult);
    print(results.length === 1 ? results[0] : results, bool(args,"json"));
    return;
  }
  const statement = database.prepare("UPDATE workspace SET lease_expires_at = 0, updated_at = ?, detail = 'owner released lease' WHERE id = ?");
  const updatedAt = Date.now();
  for (const candidate of records) statement.run(updatedAt, candidate.id);
  const current = records.map((candidate) => recordBy(database, { id: candidate.id }));
  const result = reconcileRecords(database, current, {
    execute: true,
    reapExpired: bool(args, "reap-expired"),
    preserveRuntime: bool(args, "preserve-runtime"),
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
function pruneReleased(database, now = Date.now(), root) {
  const stale = root === undefined
    ? database.prepare("SELECT id, path FROM workspace WHERE state = 'released' AND updated_at < ?").all(now - RELEASED_RETENTION_MS)
    : database.prepare("SELECT id, path FROM workspace WHERE state = 'released' AND updated_at < ? AND root=?").all(now - RELEASED_RETENTION_MS, path.resolve(root));
  const remove = database.prepare("DELETE FROM workspace WHERE id = ?");
  let pruned = 0;
  for (const row of stale) {
    if (existsSync(row.path)) continue;
    remove.run(row.id);
    pruned += 1;
  }
  database.exec("DELETE FROM workspace_capacity WHERE NOT EXISTS (SELECT 1 FROM workspace WHERE workspace.id=workspace_capacity.workspace_id)");
  database.exec("DELETE FROM workspace_capacity_measurement WHERE NOT EXISTS (SELECT 1 FROM workspace WHERE workspace.id=workspace_capacity_measurement.workspace_id)");
  return pruned;
}

function repriceCapacityCommand(database, args, statePath, resume = false) {
  assertOnly(args, ["id", "path", "intent", "headroom-gib", "growth-mib", "json", ...(resume ? ["owner", "expected-plan-sha256"] : ["owner", "reduction", "reduction-sha256"])]);
  const intent = capacityIntent(args);
  if (intent === null) fail("reprice-capacity requires explicit intent, headroom and remaining growth");
  const reducing = !resume && args.named.has("reduction");
  let reduction = null;
  let reductionSha256 = null;
  if (reducing) {
    const bytes = readFileSync(required(args, "reduction"), "utf8");
    reductionSha256 = digest(bytes);
    if (reductionSha256 !== required(args, "reduction-sha256")) growthError("growth-evidence-changed", "reduction bytes changed");
    try { reduction = JSON.parse(bytes); } catch { growthError("invalid-growth-reduction", "reduction must be JSON"); }
  } else if (!resume && (args.named.has("owner") || args.named.has("reduction-sha256"))) growthError("invalid-growth-reduction", "reduction evidence is required with reduction options");
  const selected = reducing ? growthSelected(database, args) : recordBy(database, selectorFrom(args));
  return withWorkspaceLock(database, selected.path, () => {
    const record = recordBy(database, { id: selected.id });
    if (!["active", "referenced", "blocked", "repair-required"].includes(record.state)) fail(`workspace cannot reprice capacity from state ${record.state}`);
    const row = database.prepare("SELECT device_id,plan_json FROM workspace_capacity WHERE workspace_id=?").get(record.id);
    if (row === undefined) fail("capacity repricing requires an existing capacity plan");
    const oldPlan = JSON.parse(row.plan_json);
    const retired = retainedGrowth(oldPlan);
    if (retainedParent(database,record.path)) growthError("growth-admission-required", "shared Git parent requires resume-growth admission");
    if (retired !== resume) growthError("growth-admission-required", retired ? "use explicit resume-growth admission" : "growth is not retired");
    if (resume && (record.owner !== required(args, "owner") || digest(row.plan_json) !== required(args, "expected-plan-sha256"))) growthError("stale-growth-disposition", "resume owner or plan changed");
    const expandingBudget = ["source-only", "budgeted"].includes(oldPlan.intent) && (intent.intent === "budgeted" || (reducing && intent.intent === oldPlan.intent));
    if (oldPlan.intent !== "unestimated" && !expandingBudget) fail("capacity repricing accepts unestimated plans or source-only/budgeted to budgeted expansion");
    capacityRequirement(oldPlan, []);
    if (record.durableSourceCommit === null) fail("capacity repricing requires immutable source custody");
    const creationRequest = database.prepare("SELECT creation_request FROM workspace WHERE id=?").get(record.id).creation_request;
    const sparsePatterns = creationRequest === null ? [] : JSON.parse(creationRequest).sparsePatterns ?? [];
    const plan = expandingBudget ? { ...oldPlan, ...intent } : sourceCheckoutCapacity(record.path,
      record.durableSourceCommit, intent, statfsSync(record.path).bsize, sparsePatterns);
    if (!expandingBudget) plan.completedAllocationBytes = plan.constructionBytes;
    if (resume) delete plan.growthLifecycle;
    withResourceLock(statePath, `capacity:${row.device_id}`, () => {
      const measurement = cachedWorkspaceAllocation(database, record.id, record.path, row.device_id);
      if (!measurement.ok) fail(`capacity repricing requires a fresh allocated-block sample: ${measurement.error}; run measure-capacity first`);
      const sample = JSON.parse(database.prepare("SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?").get(record.id).measurement_json);
      // Recheck actual allocation under the same filesystem fence. Keep the bound
      // cache immutable, and never credit a deletion behind that cache implicitly.
      const currentSample = reducing ? workspaceAllocationSample(record.path, row.device_id) : sample;
      if (!currentSample.ok) growthError("growth-sample-required", currentSample.error);
      const accountedBytes = Math.max(sample.bytes, currentSample.bytes);
      const sampledGrowthBytes = Math.max(0, accountedBytes - capacityAllocationBaseline(plan, record.state));
      plan.growthBytes += sampledGrowthBytes;
      capacityRequirement(plan, []);
      if (reducing) {
        validateReduction(reduction, growthBinding(database, record).binding, required(args, "owner"), intent.growthBytes);
        if (!expandingBudget || plan.growthBytes >= oldPlan.growthBytes || plan.headroomBytes < Math.max(oldPlan.headroomBytes, 8 * 1024 ** 3)) {
          growthError("unsafe-growth-reduction", "reduction must lower total future budget, preserve headroom and retain the 8 GiB floor");
        }
      }
      if (expandingBudget && (plan.headroomBytes < oldPlan.headroomBytes || (!resume && !reducing && plan.growthBytes < oldPlan.growthBytes))) {
        fail("budget expansion cannot reduce headroom or total growth budget");
      }
      plan.repricing = { priorIntent: oldPlan.intent, sampledGrowthBytes, remainingGrowthBytes: intent.growthBytes,
        measurementStartedAt: sample.startedAt, measurementCompletedAt: sample.completedAt, marginBytes: measurement.marginBytes };
      if (reducing) {
        plan.repricing.reduction = { ...reduction, sha256: reductionSha256 };
        plan.repricing.currentMeasurement = currentSample;
      }
      if (!reducing) plan.admission = assertCapacity(record.root, args, database, record.path, {
        ...plan, constructionBytes: 0, growthBytes: remainingCapacityBytes(plan, record.state, measurement),
      });
      database.exec("BEGIN IMMEDIATE");
      try {
        if (reducing) {
          const current = recordBy(database, {id:record.id});
          validateReduction(reduction, growthBinding(database, current).binding, required(args, "owner"), intent.growthBytes);
          const fresh = cachedWorkspaceAllocation(database, record.id, record.path, row.device_id);
          if (!fresh.ok) growthError("growth-sample-required", fresh.error);
          plan.admission = assertCapacity(record.root, args, database, record.path,
            {...plan, constructionBytes:0, growthBytes:remainingCapacityBytes(plan, current.state, fresh)},
            {...oldPlan, constructionBytes:0, growthBytes:remainingCapacityBytes(oldPlan, current.state, fresh)});
        }
        const changed = database.prepare("UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=? AND plan_json=?")
          .run(JSON.stringify(plan), record.id, row.plan_json).changes;
        if (changed !== 1) fail("capacity repricing conflicts with another plan change");
        database.prepare("INSERT INTO workspace_capacity_repricing(workspace_id,occurred_at,old_plan_json,new_plan_json,measurement_json) VALUES(?,?,?,?,?)")
          .run(record.id, Date.now(), row.plan_json, JSON.stringify(plan), JSON.stringify(sample));
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    });
    print(creationRecord(database, record.id), bool(args, "json"));
  }, selected.groupId);
}


function growthBinding(database, record) {
  const row = database.prepare("SELECT device_id,plan_json FROM workspace_capacity WHERE workspace_id=?").get(record.id);
  const measurement = database.prepare("SELECT measurement_json FROM workspace_capacity_measurement WHERE workspace_id=?").get(record.id);
  if (!row || !measurement) growthError("growth-sample-required", "existing plan and allocated-block sample required");
  const plan = JSON.parse(row.plan_json);
  capacityRequirement(plan, []);
  retainedGrowth(plan);
  const root = lstatSync(record.path);
  if (!root.isDirectory() || String(root.dev) !== row.device_id) growthError("growth-identity-changed", "root is not the reserved directory/filesystem");
  const dependencies = gitDependencySnapshot(database);
  const borrowerRows = [...new Set([...dependencies.alternates.filter(value => value.recordId !== record.id && within(record.path,value.objectDirectory)),
    ...dependencies.linkedWorktrees.filter(value => value.recordId !== record.id && within(record.path,value.commonDirectory))].map(value => value.recordId))]
    .sort().map(id => recordBy(database,{id}));
  const binding = { borrowersSha256:digest(JSON.stringify(borrowerRows)), id: record.id, path: record.path, owner: record.owner, sourceCommit: record.sourceCommit,
    durableSourceCommit: record.durableSourceCommit, head:git(record.path, ["rev-parse", "HEAD"]), state: record.state, updatedAt: record.updatedAt,
    leaseExpiresAt: record.leaseExpiresAt, device: row.device_id, inode: String(root.ino),
    planSha256: digest(row.plan_json), sampleSha256: digest(measurement.measurement_json) };
  return { binding, row, plan, measurement };
}

function growthSelected(database, args) {
  const record = recordBy(database, { id: required(args, "id") });
  if (record.path !== path.resolve(required(args, "path"))) growthError("growth-identity-changed", "id and path do not name the same workspace");
  return record;
}

function growthStatusCommand(database, args, statePath) {
  assertOnly(args, ["id", "path", "json"]);
  const selected = growthSelected(database, args);
  withWorkspaceLock(database, selected.path, () => {
    const {binding, plan, measurement} = growthBinding(database, recordBy(database, {id:selected.id}));
    const sampleStatus = cachedWorkspaceAllocation(database, selected.id, selected.path, binding.device);
    print({ok:true, binding, plan, sample:JSON.parse(measurement.measurement_json), sampleStatus}, bool(args, "json"));
  }, selected.groupId);
}

function growthProcessReferences(paths) {
  const snapshot = processSnapshot(true,paths);
  return paths.flatMap(root => processReferences(root,snapshot).map(reference => ({...reference,root})));
}
function growthSafety(database, record) {
  const isolated = process.env.NODE_TEST_CONTEXT !== undefined && process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY === "empty";
  const dependencies = gitDependencySnapshot(database);
  const retainedBorrowers = [...dependencies.alternates.filter(value => value.recordId !== record.id && within(record.path, value.objectDirectory)),
    ...dependencies.linkedWorktrees.filter(value => value.recordId !== record.id && within(record.path, value.commonDirectory))];
  const borrowers = new Map(retainedBorrowers.map(value => [value.workspacePath, recordBy(database,{id:value.recordId})]));
  // Include Git's complete linked-worktree list, not just registered borrowers.
  const common = path.resolve(record.path, git(record.path,["rev-parse","--git-common-dir"]));
  if (common === path.join(record.path,".git")) for (const line of git(record.path,["worktree","list","--porcelain"]).split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const borrowerPath = line.slice(9);
    if (borrowerPath !== record.path && !borrowers.has(borrowerPath)) growthError("growth-writer-unknown", `unregistered linked borrower ${borrowerPath}`);
  }
  const paths = [record.path,...borrowers.keys()];
  let processes = [];
  if (!isolated) {
    if (process.getuid?.() === 0) processes = growthProcessReferences(paths);
    else {
      const observed = command("sudo", ["-n", process.execPath, new URL(import.meta.url).pathname,
        "growth-process-snapshot", ...paths.flatMap(value => ["--path",value])], {timeout:10_000});
      if (observed.status !== 0) growthError("growth-writer-unknown", `privileged process observation failed: ${observed.stderr}`);
      try { processes = JSON.parse(observed.stdout); } catch { growthError("growth-writer-unknown", "invalid process observation"); }
      if (!Array.isArray(processes)) growthError("growth-writer-unknown", "process observation is not an array");
    }
  }
  const docker = isolated ? {containers:[], available:false} : dockerSnapshot();
  const systemd = isolated ? {units:[], available:false} : systemdSnapshot();
  const threads = isolated && !process.env.PI_THREAD_DATABASE ? [] : threadSnapshot();
  const containers = dockerReferences(record.path, docker);
  const units = systemdReferences(record.path, systemd);
  return {errors:[docker.error, systemd.error].filter(value => value !== undefined),
    references:[...processes, ...containers.references, ...units.references,
      ...threads.filter(thread => paths.some(root => within(root, thread.cwd))),
      ...[...borrowers.values()].filter(borrower => borrower.leaseExpiresAt > Date.now()).map(borrower => ({kind:"borrower-writing-lease",id:borrower.id})),
      ...[...borrowers.keys()].flatMap(root => [...dockerReferences(root,docker).references, ...systemdReferences(root,systemd).references])],
    // Borrowing Git objects is retention, not a growth writer in the parent's checkout.
    retainedBorrowers,
    observedAt:Date.now()};
}

function materializationProcessReferences(roots) {
  const snapshot = processSnapshot(true, roots, "all");
  return roots.flatMap(root => processReferences(root, snapshot).map(reference => ({...reference, root})));
}
function materializationSafety(database, parent, roots) {
  if (!Array.isArray(roots) || roots.length !== 2 || roots.some(root => typeof root !== "string" || !path.isAbsolute(root)))
    throw new MaterializationError("materialization-safety-unknown", "exact original and staging roots required");
  if (process.env.PI_WORKSPACE_TEST_EXTERNAL_SAFETY !== undefined || process.env.NODE_TEST_CONTEXT !== undefined)
    throw new MaterializationError("materialization-safety-unknown", "native materialization safety has no test override");
  let processes;
  if (process.getuid?.() === 0) processes = materializationProcessReferences(roots);
  else {
    const observed = command("sudo", ["-n", process.execPath, new URL(import.meta.url).pathname,
      "materialization-process-snapshot", ...roots.flatMap(root => ["--path", root])], {timeout: 10000});
    if (observed.status !== 0) throw new MaterializationError("materialization-safety-unknown", `privileged all-FD observer failed: ${observed.stderr}`);
    try { processes = JSON.parse(observed.stdout); } catch { throw new MaterializationError("materialization-safety-unknown", "invalid process observation JSON"); }
    if (!Array.isArray(processes) || processes.some(row => !row || !Number.isSafeInteger(row.pid) || !Array.isArray(row.matches)))
      throw new MaterializationError("materialization-safety-unknown", "invalid process observations");
  }
  const docker = dockerSnapshot(), systemd = systemdSnapshot(), threads = threadSnapshot();
  const dependencies = gitDependencySnapshot(database);
  const retainedBorrowers = [...dependencies.alternates, ...dependencies.linkedWorktrees].filter(value =>
    value.recordId !== parent.id && roots.some(root =>
      typeof value.objectDirectory === "string" && within(root, value.objectDirectory) ||
      typeof value.commonDirectory === "string" && within(root, value.commonDirectory)));
  return {errors: [docker.error, systemd.error].filter(value => value !== undefined),
    references: [...processes, ...roots.flatMap(root => [...dockerReferences(root, docker).references, ...systemdReferences(root, systemd).references]),
      ...threads.filter(thread => typeof thread.cwd !== "string" || roots.some(root => within(root, thread.cwd)))],
    retainedBorrowers, observedAt: Date.now()};
}
function retireSourceMaterializationCommand(database, args, statePath) {
  assertOnly(args, ["id", "path", "owner", "request", "request-sha256", "repository", "json"]);
  if (!bool(args, "json")) throw new MaterializationError("materialization-invalid-request", "--json is required");
  const selected = growthSelected(database, args), requestPath = required(args, "request");
  const repository = one(args, "repository");
  if (repository !== undefined && (repository !== "owi-link/converge" || !["https://github.com/owi-link/converge.git", "git@github.com:owi-link/converge.git", "ssh://git@github.com/owi-link/converge.git"].includes(selected.repository)))
    throw new MaterializationError("materialization-custody-required", "explicit Converge repository scope does not match registered parent");
  if (!path.isAbsolute(requestPath) || path.normalize(requestPath) !== requestPath || realpathSync(requestPath) !== requestPath)
    throw new MaterializationError("materialization-invalid-request", "unaliased absolute request path required");
  const stat = lstatSync(requestPath);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
    throw new MaterializationError("materialization-invalid-request", "single-link request file <=64KiB required");
  const bytes = readFileSync(requestPath);
  if (digest(bytes) !== required(args, "request-sha256")) throw new MaterializationError("materialization-evidence-changed", "request SHA256 mismatch");
  let request;
  try { request = JSON.parse(bytes); } catch { throw new MaterializationError("materialization-invalid-request", "request must be JSON"); }
  validateMaterializationRequest(request);
  if (request.parent.id !== selected.id || request.parent.path !== selected.path || request.parent.owner !== required(args, "owner") || selected.owner !== request.parent.owner)
    throw new MaterializationError("materialization-identity-changed", "id/path/owning release mismatch");
  if (within(selected.path, requestPath)) throw new MaterializationError("materialization-invalid-request", "request must be independently retained outside parent");
  const deadline = Date.now() + 150000;
  const result = duringInspection(deadline, () => withWorkspaceLock(database, selected.path, () =>
    withResourceLock(statePath, `source-materialization:${request.source.path}`, () => retireSourceMaterialization({
      database, stateDirectory: path.dirname(statePath),
      parentBinding: () => {
        const record = recordBy(database, {id: selected.id});
        if (["creating", "reclaiming", "released"].includes(record.state)) throw new MaterializationError("materialization-identity-changed", "parent lifecycle changed");
        const current = lstatSync(record.path, {bigint: true});
        return {id: record.id, path: record.path, owner: record.owner, head: git(record.path, ["rev-parse", "HEAD"]), device: String(current.dev), inode: String(current.ino)};
      },
      safety: roots => materializationSafety(database, recordBy(database, {id: selected.id}), roots),
      invalidate: () => database.prepare("DELETE FROM workspace_capacity_measurement WHERE workspace_id=?").run(selected.id),
    }, request), deadline), selected.groupId, deadline));
  print(result, true);
  if (!result.ok) process.exitCode = 2;
}

function retireGrowthCommand(database, args, statePath) {
  assertOnly(args, ["id", "path", "owner", "disposition", "disposition-sha256", "json"]);
  const selected = growthSelected(database, args);
  const evidence = readFileSync(required(args, "disposition"), "utf8");
  const evidenceSha256 = digest(evidence);
  if (evidenceSha256 !== required(args, "disposition-sha256")) growthError("growth-evidence-changed", "disposition bytes do not match the expected SHA256");
  let disposition;
  try { disposition = JSON.parse(evidence); } catch { growthError("invalid-growth-disposition", "disposition must be JSON"); }
  const deadline = Date.now()+25_000;
  duringInspection(deadline,()=>withWorkspaceLock(database, selected.path, () => {
    const record = recordBy(database, {id:selected.id});
    if (!["active", "referenced", "blocked", "repair-required"].includes(record.state)) growthError("invalid-growth-state", `cannot retire growth from ${record.state}`);
    if (record.owner !== required(args, "owner") || !record.owner || !record.durableSourceCommit) growthError("stale-growth-disposition", "current owning identity and immutable source required");
    const initial = growthBinding(database, record);
    withGrowthBorrowerLocks(database,record,()=>withResourceLock(statePath, `capacity:${initial.binding.device}`, () => {
      const {binding, plan, row, measurement} = growthBinding(database, record);
      if (!["source-only", "budgeted"].includes(plan.intent)) growthError("invalid-growth-state", "retirement requires an explicitly priced plan");
      if (retainedGrowth(plan)) growthError("growth-already-retired", "growth is already retired; no replay");
      const cached = cachedWorkspaceAllocation(database, record.id, record.path, row.device_id);
      if (!cached.ok) growthError("growth-sample-required", cached.error);
      const safety = growthSafety(database, record);
      if (Date.now() >= deadline) growthError("growth-observation-timeout", "retirement observation budget exhausted");
      validateRetirement(disposition, binding, safety);
      const next = {...plan, growthLifecycle:{kind:"retired-future-growth", remainingGrowthBytes:0,
        retainedUse:disposition.retainedUse, dispositionSha256:evidenceSha256, retiredAt:Date.now()}};
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = growthBinding(database, recordBy(database, {id:record.id}));
        validateRetirement(disposition, current.binding, safety);
        const fresh = cachedWorkspaceAllocation(database, record.id, record.path, row.device_id);
        if (!fresh.ok) growthError("growth-sample-required", fresh.error);
        database.exec(`CREATE TABLE IF NOT EXISTS workspace_growth_retirement (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, occurred_at INTEGER NOT NULL,
          record_json TEXT NOT NULL, old_plan_json TEXT NOT NULL, new_plan_json TEXT NOT NULL,
          measurement_json TEXT NOT NULL, disposition_json TEXT NOT NULL, safety_json TEXT NOT NULL)`);
        const changed = database.prepare("UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=? AND plan_json=?")
          .run(JSON.stringify(next), record.id, row.plan_json).changes;
        if (changed !== 1) growthError("stale-growth-disposition", "capacity plan CAS failed");
        const journal = database.prepare("INSERT INTO workspace_growth_retirement(workspace_id,occurred_at,record_json,old_plan_json,new_plan_json,measurement_json,disposition_json,safety_json) VALUES(?,?,?,?,?,?,?,?)")
          .run(record.id, Date.now(), JSON.stringify(record), row.plan_json, JSON.stringify(next), measurement.measurement_json, evidence, JSON.stringify(safety));
        const relinquished = database.prepare("UPDATE workspace SET lease_expires_at=0,updated_at=? WHERE id=? AND lease_expires_at=? AND updated_at=?")
          .run(Date.now(), record.id, record.leaseExpiresAt, record.updatedAt).changes;
        if (relinquished !== 1) growthError("stale-growth-disposition", "writing lease CAS failed");
        database.exec("COMMIT");
        print({ok:true, kind:"retired-future-growth", sequence:Number(journal.lastInsertRowid),
          record:creationRecord(database, record.id), dispositionSha256:evidenceSha256, safety}, bool(args,"json"));
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },deadline),deadline);
  }, selected.groupId,deadline));
}

function measureCapacityCommand(database, args, statePath) {
  assertOnly(args, ["root", "path", "id", "budget-ms", "json"]);
  const budgetMs = numberFlag(args, "budget-ms", 40_000);
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 300_000) fail("--budget-ms must be between 1 and 300000");
  const deadline = Date.now() + budgetMs;
  const selected = one(args, "id") !== undefined || one(args, "path") !== undefined ? recordBy(database, selectorFrom(args)).id : null;
  const root = one(args, "root") === undefined ? null : path.resolve(one(args, "root"));
  return withResourceLock(statePath, "capacity-measurement", () => {
    const rows = database.prepare(`SELECT w.id,w.path,w.state,w.group_id,c.device_id,c.plan_json FROM workspace w
      JOIN workspace_capacity c ON c.workspace_id=w.id LEFT JOIN workspace_capacity_measurement m ON m.workspace_id=w.id
      WHERE w.state!='released' AND (? IS NULL OR w.id=?) AND (? IS NULL OR w.root=?)
      ORDER BY coalesce(json_extract(m.measurement_json,'$.completedAt'),0),w.id`).all(selected, selected, root, root);
    const paths = database.prepare("SELECT path FROM workspace WHERE state!='released'").all().map(row => row.path);
    const results = [];
    for (const row of rows) {
      const plan = JSON.parse(row.plan_json);
      if (plan.intent !== "unestimated" && plan.growthBytes === 0 && row.state !== "creating") continue;
      if (Date.now() >= deadline) { results.push({ path: row.path, status: "deferred" }); continue; }
      const store = sample => {
        database.prepare(`INSERT OR REPLACE INTO workspace_capacity_measurement(workspace_id,measurement_json)
          SELECT ?,? WHERE EXISTS(SELECT 1 FROM workspace WHERE id=? AND state!='released')`).run(row.id, JSON.stringify(sample), row.id);
        return sample;
      };
      let sample;
      try {
        sample = withWorkspaceLock(database, row.path, () => store(workspaceAllocationSample(row.path, row.device_id, {
          deadline: Math.min(deadline, Date.now() + 60_000), maxEntries: 2_000_000,
          excludedPaths: paths.filter(candidate => candidate.startsWith(`${row.path}${path.sep}`)),
        })), row.group_id);
      } catch (error) { sample = store({ ok: false, startedAt: Date.now(), completedAt: Date.now(), error: error.message }); }
      results.push({ path: row.path, status: sample.ok ? "measured" : "error", ...sample });
    }
    print(results, bool(args, "json"));
  });
}

function reconcileCommand(database, args, statePath) {
  assertOnly(args, ["root", "id", "path", "execute", "reap-expired", "preserve-runtime", "ignore-lease", "json", "max-groups", "budget-ms", "after"]);
  const started = Date.now();
  const budget = numberFlag(args, "budget-ms", 20_000);
  const maxGroups = numberFlag(args, "max-groups", 32);
  if (budget < 1 || budget > 40_000) fail("--budget-ms must be between 1 and 40000");
  if (!Number.isSafeInteger(maxGroups) || maxGroups < 1) fail("--max-groups must be a positive integer");
  const execute = bool(args, "execute");
  if (execute) pruneReleased(database, Date.now(), one(args, "root"));
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
    preserveRuntime: bool(args, "preserve-runtime"),
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
      const result = withWorkspaceLock(database, record.path, () => maintainReferenceClone(record.path, bool(args, "execute"), registryPaths.get(database)), record.groupId);
      if (result) results.push(result);
    } catch (error) {
      results.push({ path: record.path, error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    }
  }
  if (bool(args, "json")) print(results, true);
  else for (const result of results) process.stdout.write(`${result.path}\t${result.error ?? `${result.settings.join(",") || "configured"}; gc.log ${result.gcLog}; objects ${result.objectCustody}`}\n`);
}

function statusCommand(database, args) {
  assertOnly(args, ["root", "json", "path", "owner", "limit", "after"]);
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
  const limitText = one(args, "limit") ?? "100";
  if (!/^[1-9][0-9]*$/.test(limitText) || Number(limitText) > 500) fail("--limit must be an integer from 1 to 500");
  const limit = Number(limitText);
  const after = one(args, "after");
  const matched = database.prepare(`SELECT count(*) AS count FROM workspace${where}`).get(...parameters).count;
  const pagePredicates = [...predicates], pageParameters = [...parameters];
  if (after !== undefined && after !== "start") {
    let cursor;
    try { cursor = JSON.parse(Buffer.from(after, "base64url").toString("utf8")); } catch { fail("invalid --after status cursor"); }
    if (!Array.isArray(cursor) || cursor.length !== 3 || cursor.some(value => typeof value !== "string")) fail("invalid --after status cursor");
    pagePredicates.push("(root, path, id) > (?, ?, ?)");
    pageParameters.push(...cursor);
  }
  const pageWhere = pagePredicates.length ? ` WHERE ${pagePredicates.join(" AND ")}` : "";
  // Cache declarations and pending creation payloads belong to lifecycle operations, not pool status.
  const rows = database.prepare(`SELECT id, path, root, kind, mode, owner, repository, source_commit, ${ASSIGNMENT_SOURCE}, checkout_type,
    length(cache_paths) AS cache_bytes, length(creation_request) AS creation_bytes,
    created_at, updated_at, lease_expires_at, state, detail, group_id
    FROM workspace${pageWhere} ORDER BY root, path, id LIMIT ?`).all(...pageParameters, limit + 1);
  const hasMore = rows.length > limit;
  const records = rows.slice(0, limit).map(row => {
    const { cachePaths, ...record } = rowToRecord({ ...row, cache_paths: "[]", creation_request: "null" });
    delete record.creation;
    return { ...record, capacity: recordedCapacity(database, row.id), cacheDeclarationBytes: row.cache_bytes, creationRequestBytes: row.creation_bytes };
  });
  const last = rows[Math.min(rows.length, limit) - 1];
  const nextAfter = hasMore && last ? Buffer.from(JSON.stringify([last.root, last.path, last.id])).toString("base64url") : null;
  if (bool(args, "json")) {
    print({ records, matched, limit, nextAfter }, true);
    return;
  }
  const filtered = pathFilter !== undefined || ownerFilter !== undefined;
  const total = !filtered ? matched : root === undefined
    ? database.prepare("SELECT count(*) AS count FROM workspace").get().count
    : database.prepare("SELECT count(*) AS count FROM workspace WHERE root = ?").get(path.resolve(root)).count;
  if (filtered && matched === 0) {
    process.stdout.write(`no registered workspace matches that filter; ${total} record(s) are known, and a checkout absent from all of them was never registered\n`);
    return;
  }
  const summary = new Map();
  for (const record of records) summary.set(record.state, (summary.get(record.state) ?? 0) + 1);
  const scope = filtered ? ` (filtered from ${total})` : "";
  process.stdout.write(`${records.length} of ${matched} registered workspace(s)${scope} on this page: ${[...summary].map(([state, count]) => `${state}=${count}`).join(" ")}\n`);
  if (nextAfter) process.stdout.write(`more records: agent-workspace status --after ${nextAfter} (repeat the same filters)\n`);
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
  agent-workspace create --root PATH --name NAME --repo URL [--ref GIT_REF] [--mode writer|review] [--group ID] [--cache PATH,...] [--creation-timeout-seconds 300] [--sparse-pattern PATTERN ...]
                         [--intent source-only|budgeted --headroom-gib N --growth-mib N]
  agent-workspace job-status --job-id SHA256 [--json]
  agent-workspace source-status --job-id SHA256 [--json]
  agent-workspace register --path PATH [--owner ID] [--source-commit SHA] [--group ID] [--cache PATH,...] [--cache-owned OUTPUT=TRACKED_SOURCE] [--replace-cache]
  agent-workspace reassign --id ID --path PATH --from-owner ID --from-source-commit SHA|unset --from-state STATE
                           --owner ID --source-commit HEAD_SHA --authorization RECEIPT [--json]
  agent-workspace adopt --root PATH [--mode writer|review] [--nested-groups] [--cache PATH,...] [--cache-owned OUTPUT=TRACKED_SOURCE] [--replace-cache] [--execute]
  agent-workspace cancel-creation (--id ID|--path PATH)
  agent-workspace finalize-creation (--id ID|--path PATH)
  agent-workspace heartbeat (--id ID|--path PATH) [--lease-seconds N]
  agent-workspace release (--id ID|--path PATH) [--reap-expired] [--preserve-runtime]
  agent-workspace release (--id ID|--path PATH) --end-retention --owner OWNER --expected-plan-sha256 SHA [--json]
  agent-workspace reconcile [--root PATH] [--execute] [--reap-expired] [--preserve-runtime]
                            [--budget-ms 20000] [--max-groups 32] [--after ID|start]
  agent-workspace measure-capacity [--root PATH | --path PATH | --id ID] [--budget-ms 40000] [--json]
  agent-workspace reprice-capacity (--id ID|--path PATH) --intent source-only|budgeted --headroom-gib N --growth-mib N [--json]
  Active reduction additionally requires --id ID --path PATH --owner OWNER --reduction FILE --reduction-sha256 SHA256
  agent-workspace growth-status --id ID --path PATH [--json]
  agent-workspace retire-source-materialization --id ID --path PATH --owner OWNER --request ABS_FILE --request-sha256 SHA --json
  agent-workspace retire-growth --id ID --path PATH --owner OWNER --disposition FILE --disposition-sha256 SHA [--json]
  agent-workspace resume-growth (--id ID|--path PATH) --owner OWNER --expected-plan-sha256 SHA --intent budgeted --headroom-gib N --growth-mib N [--json]
  agent-workspace maintain [--root PATH | --path PATH] [--execute] [--json]
  agent-workspace status [--root PATH] [--path SUBSTRING] [--owner SUBSTRING] [--limit 100] [--after CURSOR|start] [--json]
  agent-workspace list ...                    alias for status

The registry defaults to ${DEFAULT_STATE}. Set PI_WORKSPACE_STATE to move it.
Repeat --cache to declare ignored generated paths that release may remove; these extend the default cache set.
Use a Git ref the source repository can fetch, such as refs/heads/main or a branch name, not origin/main.
Clone checkout is a durable systemd user job; exit 75 with state creating includes a read-only job-status command.
Checkout budgets scale with immutable path count and construction bytes; --creation-timeout-seconds accepts 1–86400.
A caller timeout cannot interrupt it. New clones publish atomically; failed/interrupted staging is removed.
Use repeatable --sparse-pattern PATTERN (Git non-cone patterns) to materialize only selected source paths.
A lease expiry permits reconciliation; it never makes dirty or unpushed work disposable.
Records with the same --group lease, heartbeat, and release as one multi-repository workspace.
Records outlive the directory, so status explains what became of a checkout that is gone;
--path takes a substring, so "status --path ob50" answers that without reading every record.
`);
}

export const workspaceTesting = { inspectRecord, capacityRefusalDetails, checkoutConstructionCapacity, allocatedWorkspaceBytes, workspaceAllocationSample, cachedWorkspaceAllocation, remainingCapacityBytes, capacityRequirement, capacityReservations, gitDependencySnapshot, sourceCapacityPlan, cacheTargets, dockerEndpointScope, dockerSnapshot, groupReconciliation, maintainReferenceClone, parseSystemdUnits, pruneReleased, systemdManagerSnapshot, systemdReferences, ownerThreadDatabases, threadSnapshot };

export function main(argv = process.argv.slice(2), statePath = DEFAULT_STATE) {
  if (argv[0] === "materialization-process-snapshot") {
    if (process.getuid?.() !== 0) throw new MaterializationError("materialization-safety-unknown", "all-FD observation requires root");
    const args = parseArgs(argv.slice(1)); assertOnly(args, ["path"]);
    const roots = many(args, "path");
    if (roots.length !== 2 || roots.some(root => !path.isAbsolute(root))) throw new MaterializationError("materialization-invalid-request", "exact original/stage paths required");
    print(materializationProcessReferences(roots), true); return;
  }
  if (argv[0] === "growth-process-snapshot") {
    if (process.getuid?.() !== 0) growthError("growth-writer-unknown", "privileged process observation requires root");
    const args = parseArgs(argv.slice(1));
    assertOnly(args, ["path"]);
    const paths = many(args, "path");
    if (!paths.length || paths.some(target => !path.isAbsolute(target))) growthError("invalid-growth-disposition", "absolute paths required");
    print(growthProcessReferences(paths), true);
    return;
  }
  if (argv[0] === "source-prepare") return sourcePreparationWorker();
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
  if (commandName === "source-status" || commandName === "job-status") {
    assertOnly(args, ["job-id", "json"]);
    const jobId = required(args, "job-id");
    const result = observeWorkspaceJob(statePath, jobId, commandName === "source-status" ? "source" : null);
    print({ jobId, ...result }, true);
    process.exitCode = result.state === "pending" ? 75 : result.state === "ready" ? 0 : 2;
    return;
  }
  if (commandName === "create") {
    const budgetMs = creationTimeout(args);
    const repository = repositoryLocation(required(args, "repo"), currentDirectory());
    if (process.env.PI_WORKSPACE_CREATE_CHILD !== statePath) {
      args.named.set("root", [path.resolve(required(args, "root"))]);
      args.named.set("repo", [repository]);
      const normalized = [...args.named].flatMap(([name, values]) => values.map((value) => `--${name}=${value}`));
      const result = command("timeout", ["--kill-after=1", String(budgetMs / 1000),
        process.execPath, new URL(import.meta.url).pathname, "create", ...normalized], {
        timeout: budgetMs + 3_000,
        env: { PI_WORKSPACE_STATE: statePath, PI_WORKSPACE_CREATE_CHILD: statePath },
      });
      if ([124, 137].includes(result.status) || result.error?.code === "ETIMEDOUT") {
        fail("creation budget exhausted; pending reservation retained, not active; repeat the same create command to retry, optionally increasing --creation-timeout-seconds (maximum 86400)");
      }
      if (result.status === 75 && result.stdout) {
        const pending = JSON.parse(result.stdout);
        if (pending.state === "preparing" && pending.jobId && pending.progressPath) {
          process.stdout.write(`${result.stdout}\n`);
          process.exitCode = 75;
          return;
        }
      }
      if (result.status === 75) {
        if (result.stdout) {
          process.stdout.write(`${result.stdout}\n`);
          process.exitCode = 75;
          return;
        }
        throw new ResourceBusyError(result.stderr);
      }
      if (result.status !== 0) fail(result.stderr || result.error?.message ||
        "creation interrupted; repeat the same command to resume");
      process.stdout.write(`${result.stdout}\n`);
      return;
    }
    creationDeadline = Date.now() + budgetMs;
  }
  const database = openRegistry(statePath);
  try {
    if (!["status", "list", "maintain", "cancel-creation", "finalize-creation", "reassign", "release", "retire-source-materialization", "growth-status", "retire-growth", "resume-growth"].includes(commandName)
      && (commandName !== "reconcile" || bool(args, "execute"))) {
      const scopedRoot = commandName === "reconcile" ? one(args, "root") : undefined;
      const scopedIds = scopedRoot === undefined ? undefined
        : database.prepare("SELECT id FROM workspace WHERE root=?").all(path.resolve(scopedRoot)).map(row => row.id);
      drainGc(statePath, scopedIds);
    }
    if (commandName === "create") createCommand(database, args, statePath);
    else if (commandName === "register") registerCommand(database, args);
    else if (commandName === "reassign") reassignCommand(database, args);
    else if (commandName === "adopt") adoptCommand(database, args, statePath);
    else if (["heartbeat", "release", "cancel-creation", "finalize-creation"].includes(commandName)) {
      const record = recordBy(database, selectorFrom(args));
      withWorkspaceLock(database, record.path, () => {
        if (commandName === "heartbeat") heartbeatCommand(database, args);
        else if (commandName === "cancel-creation") cancelCreationCommand(database, args);
        else if (commandName === "finalize-creation") finalizeCreationCommand(database, args, statePath);
        else releaseCommand(database, args, statePath);
      }, record.groupId);
    }
    else if (commandName === "reconcile") reconcileCommand(database, args, statePath);
    else if (commandName === "measure-capacity") measureCapacityCommand(database, args, statePath);
    else if (commandName === "growth-status") growthStatusCommand(database, args, statePath);
    else if (commandName === "retire-source-materialization") retireSourceMaterializationCommand(database, args, statePath);
    else if (commandName === "retire-growth") retireGrowthCommand(database, args, statePath);
    else if (commandName === "resume-growth") repriceCapacityCommand(database, args, statePath, true);
    else if (commandName === "reprice-capacity") repriceCapacityCommand(database, args, statePath);
    else if (commandName === "maintain") maintainCommand(database, args);
    else if (commandName === "status" || commandName === "list") statusCommand(database, args);
    else {
      help();
      fail(`unknown command: ${commandName}`);
    }
  } finally {
    database.close();
    creationDeadline = undefined;
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
    if (process.argv.some(value => value === "--json" || value === "--json=true")) {
      if (error instanceof RegistrationMismatchError) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: {
          code: error.code, field: error.field, requested: error.requested, recorded: error.recorded,
        } })}\n`);
      } else if (["reassign", "retire-source-materialization", "materialization-process-snapshot", "retire-growth", "growth-status", "resume-growth"].includes(process.argv[2]) || error instanceof GrowthLifecycleError || error instanceof MaterializationError) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: {
          code: error instanceof GrowthLifecycleError || error instanceof MaterializationError ? error.code : error instanceof ResourceBusyError ? "resource-busy" : error instanceof CliError ? "invalid-request" : "lifecycle-failed",
          detail: error instanceof Error ? error.message : String(error),
        } })}\n`);
      }
    }
    process.stderr.write(`agent-workspace: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(error instanceof ResourceBusyError ? 75 : (error instanceof CliError || error instanceof GrowthLifecycleError || error instanceof MaterializationError) ? 2 : 1);
  }
}
