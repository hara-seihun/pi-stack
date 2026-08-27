#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  statfsSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_STATE = process.env.PI_WORKSPACE_STATE ?? path.join(
  process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"),
  "pi-workspaces",
  "registry.sqlite3",
);
const DEFAULT_CACHE_PATHS = ["node_modules", "**/node_modules", ".nx", ".converge-cache"];
const DEFAULT_LEASE_SECONDS = 6 * 60 * 60;
const DEFAULT_MAX_COUNT = 32;
const DEFAULT_MIN_FREE_GIB = 30;
const DEFAULT_MIN_FREE_INODES_PERCENT = 10;

class CliError extends Error {}

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

function command(executable, commandArgs, options = {}) {
  const result = spawnSync(executable, commandArgs, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout ?? 30_000,
  });
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

function openRegistry(statePath = DEFAULT_STATE) {
  mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(statePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
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
      group_id TEXT
    );
    CREATE INDEX IF NOT EXISTS workspace_root ON workspace(root);
    CREATE INDEX IF NOT EXISTS workspace_lease ON workspace(lease_expires_at);
  `);
  const columns = database.prepare("PRAGMA table_info(workspace)").all();
  if (!columns.some((column) => column.name === "group_id")) {
    database.exec("ALTER TABLE workspace ADD COLUMN group_id TEXT");
  }
  database.exec("CREATE INDEX IF NOT EXISTS workspace_group ON workspace(group_id)");
  return database;
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

function normalizeCachePaths(values) {
  const selected = values.length === 0 ? DEFAULT_CACHE_PATHS : values.flatMap((value) => value.split(","));
  return [...new Set(selected.map((value) => value.trim()).filter(Boolean).map((value) => {
    if (path.isAbsolute(value) || value.split(path.sep).includes("..")) fail(`cache path must be relative: ${value}`);
    const normalized = value.replace(/^\.\//, "").replace(/\/$/, "");
    if (/[?\[\]]/u.test(normalized) || (normalized.includes("*") && !/^\*\*\/[^*]+$/u.test(normalized))) {
      fail(`cache path supports only an exact path or **/directory: ${value}`);
    }
    return normalized;
  }))];
}

function register(database, input) {
  const info = gitInfo(input.path);
  const now = Date.now();
  const existing = database.prepare("SELECT * FROM workspace WHERE path = ?").get(path.resolve(input.path));
  if (existing !== undefined && existing.state !== "released") {
    const cachePaths = [...new Set([...JSON.parse(existing.cache_paths), ...input.cachePaths])];
    database.prepare("UPDATE workspace SET cache_paths = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(cachePaths), now, existing.id);
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
    leaseExpiresAt: now + input.leaseSeconds * 1000,
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
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
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

function dockerSnapshot(execute = command) {
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

function systemdManagerSnapshot(manager) {
  const managerArgs = manager === "user" ? ["--user"] : [];
  const listed = command("systemctl", [
    ...managerArgs,
    "list-units",
    "--all",
    "--state=active,activating,reloading,deactivating",
    "--type=service",
    "--type=scope",
    "--no-legend",
    "--plain",
  ], { timeout: 20_000 });
  if (listed.error?.code === "ENOENT" || /not been booted with systemd|failed to connect to bus/iu.test(listed.stderr)) {
    return { units: [], available: false };
  }
  if (listed.status !== 0) return { units: [], available: true, error: listed.stderr || listed.stdout || "systemctl list-units failed" };
  const unitIds = listed.stdout.split("\n").map((line) => line.trim().split(/\s+/u)[0]).filter(Boolean);
  if (unitIds.length === 0) return { units: [], available: true };
  const shown = command("systemctl", [
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

function gitAlternateSnapshot(database) {
  const references = [];
  for (const record of listRecords(database)) {
    if (!existsSync(record.path)) continue;
    let objectDirectory;
    if (record.checkoutType === "clone") objectDirectory = path.join(record.path, ".git", "objects");
    else {
      const common = command("git", ["-C", record.path, "rev-parse", "--git-common-dir"]);
      if (common.status !== 0) continue;
      objectDirectory = path.join(path.resolve(record.path, common.stdout), "objects");
    }
    const alternatesPath = path.join(objectDirectory, "info", "alternates");
    if (!existsSync(alternatesPath)) continue;
    let contents;
    try { contents = readFileSync(alternatesPath, "utf8"); } catch { continue; }
    for (const alternate of contents.split("\n").filter(Boolean)) {
      references.push({
        recordId: record.id,
        workspacePath: record.path,
        objectDirectory: path.resolve(objectDirectory, alternate),
      });
    }
  }
  return references;
}

function safetySnapshot(database) {
  return {
    processes: processSnapshot(),
    docker: dockerSnapshot(),
    systemd: systemdSnapshot(),
    gitAlternates: gitAlternateSnapshot(database),
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

function gitDisposition(record) {
  const status = git(record.path, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (status.length > 0) return { safe: false, reason: `working tree has changes: ${status.split("\n").slice(0, 8).join(" | ")}` };
  const ignored = git(record.path, ["status", "--porcelain=v1", "--ignored=matching", "--untracked-files=normal"])
    .split("\n")
    .filter((line) => line.startsWith("!! "))
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

function matchingCacheTargets(workspacePath, relative) {
  if (!relative.startsWith("**/")) return [path.resolve(workspacePath, relative)];
  const directoryName = relative.slice("**/".length);
  const matches = [];
  const pending = [workspacePath];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".git") continue;
      const candidate = path.join(current, entry.name);
      if (entry.name === directoryName) matches.push(candidate);
      else pending.push(candidate);
    }
  }
  return matches;
}

function stripCaches(record, statePath) {
  const removed = [];
  const seen = new Set();
  for (const relative of record.cachePaths) {
    for (const target of matchingCacheTargets(record.path, relative)) {
      if (seen.has(target) || !within(record.path, target) || target === record.path || !existsSync(target)) continue;
      seen.add(target);
      const cacheKey = createHash("sha256").update(path.relative(record.path, target)).digest("hex").slice(0, 12);
      const destination = gcDestination(statePath, record, `${path.basename(target)}-${cacheKey}`);
      moveToGc(target, destination);
      removed.push(path.relative(record.path, target));
    }
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
  if (gitDependents.length > 0) {
    return {
      classification: "referenced",
      reason: `${gitDependents.length} registered Git checkout(s) still borrow this checkout's objects: ${gitDependents.map((reference) => reference.workspacePath).join(", ")}`,
      processes,
      containers: docker.references,
      systemdUnits: systemd.references,
      gitDependents,
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
  const disposition = gitDisposition(record);
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
  let inspection = inspectRecord(record, { ignoreLease: options.ignoreLease, safety });
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
    inspection = inspectRecord({ ...current, state: "reclaiming" }, { ignoreLease: true, safety });
  }
  if (inspection.classification === "referenced" || inspection.classification === "blocked") {
    if (options.execute) updateState(database, record, inspection.classification, inspection.reason);
    return { record, inspection, action: "none" };
  }
  let removedCaches = [];
  if (options.execute) {
    removedCaches = stripCaches(record, options.statePath);
    inspection = inspectRecord(record, { ignoreLease: true, safety });
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

  let inspections = records.map((record) => inspectRecord(record, { ignoreLease: true, safety }));
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
    inspections = records.map((record) => inspectRecord(record, { ignoreLease: true, safety }));
  }

  const removedCaches = new Map();
  if (options.execute) {
    records.forEach((record, index) => {
      if (inspections[index].classification !== "missing") removedCaches.set(record.id, stripCaches(record, options.statePath));
    });
    inspections = records.map((record) => inspectRecord(record, { ignoreLease: true, safety }));
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

  records.forEach((record, index) => {
    if (inspections[index].classification === "reclaimable") removeWorkspace(record, options.statePath);
    updateState(database, record, "released", `workspace group ${groupId} released: ${inspections[index].reason}`);
  });
  for (const record of records) removeEmptyWorkspaceContainer(record);
  return records.map((record, index) => ({ record, inspection: inspections[index], action: "released-group" }));
}

function blockedReconciliation(database, records, error, execute) {
  const detail = error instanceof Error ? error.message : String(error);
  return records.map((record) => {
    if (execute) updateState(database, record, "blocked", detail);
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
  for (const selectedRecord of selected) {
    if (visited.has(selectedRecord.id)) continue;
    const records = recordsInGroup(database, selectedRecord);
    records.forEach((record) => visited.add(record.id));
    try {
      if (records.length > 1) results.push(...groupReconciliation(database, records, options));
      else if (records.length === 1) results.push(reconcileRecord(database, records[0], options));
    } catch (error) {
      results.push(...blockedReconciliation(database, records, error, options.execute));
    }
  }
  return results;
}

function print(value, json) {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (Array.isArray(value)) {
    for (const item of value) process.stdout.write(`${item.id}\t${item.state}\t${item.path}\t${item.detail}\n`);
  } else process.stdout.write(`${value.path ?? value.id}\n`);
}

function registerCommand(database, args) {
  assertOnly(args, ["path", "root", "kind", "mode", "owner", "group", "source-commit", "lease-seconds", "cache", "json"]);
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
    cachePaths: normalizeCachePaths(many(args, "cache")),
  });
  print(record, bool(args, "json"));
}

function gitRoot(candidate) {
  const probe = command("git", ["-C", candidate, "rev-parse", "--show-toplevel"]);
  return probe.status === 0 && path.resolve(probe.stdout) === candidate;
}

function adoptionCandidates(root, nestedGroups) {
  const candidates = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name);
    if (gitRoot(candidate)) {
      candidates.push({ path: candidate, groupId: null });
      continue;
    }
    if (!nestedGroups) continue;
    const groupId = `adopted-${createHash("sha256").update(candidate).digest("hex").slice(0, 20)}`;
    for (const child of readdirSync(candidate, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const nested = path.join(candidate, child.name);
      if (gitRoot(nested)) candidates.push({ path: nested, groupId });
    }
  }
  return candidates;
}

function adoptCommand(database, args, statePath) {
  assertOnly(args, ["root", "kind", "mode", "owner", "group", "nested-groups", "lease-seconds", "cache", "execute", "reap-expired", "json"]);
  const root = path.resolve(required(args, "root"));
  const mode = one(args, "mode", "writer");
  if (!["writer", "review"].includes(mode)) fail("--mode must be writer or review");
  if (!existsSync(root)) fail(`root does not exist: ${root}`);
  const records = [];
  const requestedGroup = one(args, "group");
  for (const candidate of adoptionCandidates(root, bool(args, "nested-groups"))) {
    records.push(register(database, {
      path: candidate.path,
      root,
      kind: one(args, "kind", "agent"),
      mode,
      owner: one(args, "owner", "unowned"),
      groupId: requestedGroup ?? candidate.groupId,
      sourceCommit: null,
      leaseSeconds: numberFlag(args, "lease-seconds", 0),
      cachePaths: normalizeCachePaths(many(args, "cache")),
    }));
  }
  const execute = bool(args, "execute");
  const safety = execute ? safetySnapshot(database) : undefined;
  const results = execute
    ? reconcileRecords(database, records, { execute, reapExpired: bool(args, "reap-expired"), ignoreLease: false, statePath, safety })
    : records;
  print(results, bool(args, "json"));
}

function assertCapacity(root, args) {
  mkdirSync(root, { recursive: true });
  const count = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
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

function prepareMirror(mirror, repository) {
  mkdirSync(path.dirname(mirror), { recursive: true, mode: 0o700 });
  if (!existsSync(mirror)) {
    run("git", ["init", "--bare", mirror]);
    run("git", ["--git-dir", mirror, "remote", "add", "origin", repository]);
  } else {
    run("git", ["--git-dir", mirror, "remote", "set-url", "origin", repository]);
  }
  run("git", ["--git-dir", mirror, "config", "remote.origin.mirror", "false"]);
  run("git", [
    "--git-dir", mirror, "config", "--replace-all", "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/*",
  ]);
  run("git", ["--git-dir", mirror, "fetch", "--prune", "--no-tags", "origin"], { timeout: 120_000 });
}

function fetchSource(mirror, repository, ref) {
  const digest = createHash("sha256").update(`${repository}\0${ref}`).digest("hex");
  const sourceRef = `refs/pi-workspace/sources/${digest}`;
  run("git", ["--git-dir", mirror, "fetch", "--no-tags", "origin", `+${ref}:${sourceRef}`], { timeout: 120_000 });
  return run("git", ["--git-dir", mirror, "rev-parse", sourceRef]);
}

function createCommand(database, args, statePath) {
  assertOnly(args, ["root", "name", "repo", "ref", "branch", "kind", "mode", "owner", "group", "strategy", "lease-seconds", "cache", "max-count", "min-free-gib", "min-free-inodes-percent", "json"]);
  const root = path.resolve(required(args, "root"));
  assertCapacity(root, args);
  const name = safeName(required(args, "name"));
  const destination = path.join(root, name);
  if (existsSync(destination)) fail(`workspace already exists: ${destination}`);
  const repository = required(args, "repo");
  const ref = one(args, "ref", "refs/heads/main");
  const mode = one(args, "mode", "writer");
  if (!["writer", "review"].includes(mode)) fail("--mode must be writer or review");
  const strategy = one(args, "strategy", "clone");
  if (!["clone", "worktree"].includes(strategy)) fail("--strategy must be clone or worktree");
  const mirror = mirrorFor(statePath, repository);
  prepareMirror(mirror, repository);
  const sourceCommit = fetchSource(mirror, repository, ref);
  const branch = one(args, "branch", `agent/${name}`);
  try {
    if (strategy === "worktree") {
      const worktreeArgs = ["--git-dir", mirror, "worktree", "add"];
      if (mode === "review") worktreeArgs.push("--detach", destination, sourceCommit);
      else worktreeArgs.push("-b", branch, destination, sourceCommit);
      run("git", worktreeArgs);
    } else {
      run("git", ["clone", "--reference-if-able", mirror, "--no-checkout", repository, destination], { timeout: 120_000 });
      if (mode === "review") git(destination, ["checkout", "--detach", sourceCommit]);
      else git(destination, ["checkout", "-b", branch, sourceCommit]);
    }
    const record = register(database, {
      path: destination,
      root,
      kind: one(args, "kind", "agent"),
      mode,
      owner: one(args, "owner", name),
      groupId: one(args, "group"),
      sourceCommit,
      leaseSeconds: numberFlag(args, "lease-seconds", DEFAULT_LEASE_SECONDS),
      cachePaths: normalizeCachePaths(many(args, "cache")),
    });
    print(record, bool(args, "json"));
  } catch (error) {
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function heartbeatCommand(database, args) {
  assertOnly(args, ["id", "path", "lease-seconds", "json"]);
  const record = recordBy(database, selectorFrom(args));
  if (record.state === "released" || record.state === "reclaiming") fail(`workspace cannot renew from state ${record.state}`);
  if (!existsSync(record.path)) fail(`workspace path is absent: ${record.path}`);
  const now = Date.now();
  const expires = now + numberFlag(args, "lease-seconds", DEFAULT_LEASE_SECONDS) * 1000;
  const records = recordsInGroup(database, record);
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

function reconcileCommand(database, args, statePath) {
  assertOnly(args, ["root", "id", "path", "execute", "reap-expired", "ignore-lease", "json"]);
  let records;
  if (one(args, "id") !== undefined || one(args, "path") !== undefined) records = [recordBy(database, selectorFrom(args))];
  else records = listRecords(database, one(args, "root"));
  const options = {
    execute: bool(args, "execute"),
    reapExpired: bool(args, "reap-expired"),
    ignoreLease: bool(args, "ignore-lease"),
    statePath,
    safety: safetySnapshot(database),
  };
  const results = reconcileRecords(
    database,
    records.filter((record) => record.state !== "released" || existsSync(record.path)),
    options,
  );
  print(results, bool(args, "json"));
}

function statusCommand(database, args) {
  assertOnly(args, ["root", "json"]);
  const records = listRecords(database, one(args, "root"));
  if (bool(args, "json")) {
    print(records, true);
    return;
  }
  const summary = new Map();
  for (const record of records) summary.set(record.state, (summary.get(record.state) ?? 0) + 1);
  process.stdout.write(`${records.length} registered workspace(s): ${[...summary].map(([state, count]) => `${state}=${count}`).join(" ")}\n`);
  print(records, false);
}

function help() {
  process.stdout.write(`Usage:
  agent-workspace create --root PATH --name NAME --repo URL [--ref REF] [--mode writer|review] [--group ID]
  agent-workspace register --path PATH [--owner ID] [--source-commit SHA] [--group ID]
  agent-workspace adopt --root PATH [--mode writer|review] [--nested-groups] [--execute]
  agent-workspace heartbeat (--id ID|--path PATH) [--lease-seconds N]
  agent-workspace release (--id ID|--path PATH) [--reap-expired]
  agent-workspace reconcile [--root PATH] [--execute] [--reap-expired]
  agent-workspace status [--root PATH] [--json]

The registry defaults to ${DEFAULT_STATE}. Set PI_WORKSPACE_STATE to move it.
A lease expiry permits reconciliation; it never makes dirty or unpushed work disposable.
Records with the same --group lease, heartbeat, and release as one multi-repository workspace.
`);
}

export const workspaceTesting = { dockerSnapshot, parseSystemdUnits, systemdReferences };

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
  drainGc(statePath);
  const database = openRegistry(statePath);
  try {
    if (commandName === "create") createCommand(database, args, statePath);
    else if (commandName === "register") registerCommand(database, args);
    else if (commandName === "adopt") adoptCommand(database, args, statePath);
    else if (commandName === "heartbeat") heartbeatCommand(database, args);
    else if (commandName === "release") releaseCommand(database, args, statePath);
    else if (commandName === "reconcile") reconcileCommand(database, args, statePath);
    else if (commandName === "status") statusCommand(database, args);
    else fail(`unknown command: ${commandName}`);
  } finally {
    database.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`agent-workspace: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(error instanceof CliError ? 2 : 1);
  }
}
