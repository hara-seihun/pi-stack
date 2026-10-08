#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { legacySourceManifest } from "./native-history-startup-legacy.mjs";

const NODE_24 = Number(process.versions.node.split(".")[0]) === 24;
const { DatabaseSync } = NODE_24 ? await import("node:sqlite") : { DatabaseSync: null };
const CONTRACT = "native-history-v1";
const CAPTURE_TABLES = ["session_contexts", "session_context_patches", "captured_context_unavailable", "captured_context_usage", "captured_transcript_generations"];
const MIGRATION_MS = 45_000;
const LIMIT = 100_000;
const failure = (code, message, exitCode = 75) => ({ ok: false, error: { code, message, exitCode } });
const ioFailure = (code, error, exitCode = 75) => failure(code, String(error?.message ?? error), exitCode);

function inspectPath(path, uid, kind) {
  try {
    const info = lstatSync(path);
    if (info.uid !== uid || realpathSync(path) !== path || (kind === "directory" ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
      return failure("source-ownership", `Expected ${kind} owned only by UID ${uid}, without symlinks: ${path}`, 78);
    }
    return { ok: true, value: info };
  } catch (error) {
    return error.code === "ENOENT" ? { ok: true, value: null } : ioFailure("source-unavailable", error);
  }
}

export function startupConfiguration(configPath, environment, uid) {
  try {
    if (!isAbsolute(configPath ?? "")) return failure("configuration", "PI_REMOTE_CONFIG must be an absolute path", 78);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (config?.version !== 1 || !config.environment || typeof config.environment !== "object" || Array.isArray(config.environment)) {
      return failure("configuration", "Person config requires version 1 and an environment object", 78);
    }
    const data = Object.hasOwn(environment, "PI_REMOTE_DATA") ? environment.PI_REMOTE_DATA : config.environment.PI_REMOTE_DATA;
    if (typeof data !== "string" || !isAbsolute(data) || data.includes("\0") || resolve(data) !== data || data === "/") {
      return failure("configuration", "PI_REMOTE_DATA must be explicitly set to a normalized absolute owner data directory", 78);
    }
    const check = inspectPath(data, uid, "directory");
    if (!check.ok) return check;
    const longest = join(data, "thread-sockets", `${"0".repeat(16)}.${"0".repeat(16)}.sock`);
    const socketDir = Buffer.byteLength(longest) <= 107 ? data : `/run/user/${uid}/pi/${createHash("sha256").update(data).digest("hex").slice(0, 16)}`;
    return { ok: true, value: { dataDir: data, configPath, uid, socketDir, supervisorDb: join(data, "supervisor.sqlite3"), threadDb: join(data, "threads.sqlite3"), outputDir: join(data, "native-history-retirement") } };
  } catch (error) { return ioFailure("configuration", error, 78); }
}

function schemaState(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const tables = new Set([...db.prepare("SELECT name FROM sqlite_master WHERE type='table'").iterate()].map(row => row.name));
    const marked = tables.has("metadata") && db.prepare("SELECT value FROM metadata WHERE key='native_history_contract'").get()?.value === CONTRACT;
    const captured = CAPTURE_TABLES.some(name => tables.has(name));
    const thinking = tables.has("message_facts") && [...db.prepare("PRAGMA table_info(message_facts)").iterate()].some(row => row.name === "thinking");
    const events = !marked && tables.has("events") && Boolean(db.prepare("SELECT 1 FROM events WHERE type='thinking' LIMIT 1").get());
    if (marked && (captured || thinking)) return failure("schema-recreated", "Retired producer schema exists after the native history marker; maintenance repair required", 78);
    return { ok: true, value: marked ? "migrated" : captured || thinking || events ? "migration-required" : "native-schema" };
  } catch (error) { return ioFailure("supervisor-schema", error, 78); }
  finally { db?.close(); }
}

function retainedPaths(configuration) {
  let db;
  try {
    db = new DatabaseSync(configuration.threadDb, { readOnly: true });
    const paths = new Set();
    const socketDirs = new Set([configuration.socketDir, configuration.dataDir]);
    const columns = new Set([...db.prepare("PRAGMA table_info(thread)").iterate()].map(row => row.name));
    if (!columns.has("session_file")) return failure("thread-schema", "Thread database has no native session_file mapping", 78);
    let count = 0;
    for (const row of db.prepare(`SELECT session_file${columns.has("metadata") ? ",metadata" : ""} FROM thread`).iterate()) {
      if (++count > LIMIT) return failure("census-limit", "Thread census exceeds bounded startup limit; run explicit maintenance");
      if (typeof row.session_file === "string") paths.add(row.session_file);
      if (!columns.has("metadata") || row.metadata === null) continue;
      const reference = JSON.parse(row.metadata)?.runnerReference;
      if (reference === undefined) continue;
      if (!reference || typeof reference.control !== "string" || typeof reference.socketPath !== "string"
          || !isAbsolute(reference.control) || !isAbsolute(reference.socketPath)) return failure("runner-reference", "Retained runner reference is invalid");
      if (dirname(reference.control) !== join(configuration.socketDir, "thread-runners")
          || dirname(reference.socketPath) !== join(configuration.socketDir, "thread-sockets")) return failure("runner-reference", "Retained runner reference is outside this owner's native execution boundary");
    }
    return { ok: true, value: { nativePaths: paths, socketDirs } };
  } catch (error) { return ioFailure("thread-schema", error, 78); }
  finally { db?.close(); }
}

function readinessReceipt(configuration) {
  const path = join(configuration.dataDir, "native-history-readiness.json");
  const checked = inspectPath(path, configuration.uid, "file");
  if (!checked.ok || !checked.value) return checked.ok ? { ok: true, value: "local-census" } : checked;
  try {
    if (checked.value.size > 16 * 1024) return failure("readiness-receipt", "Readiness receipt exceeds 16 KiB");
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    if (receipt.version !== 1 || receipt.contract !== CONTRACT || receipt.uid !== configuration.uid || receipt.dataDir !== configuration.dataDir
        || receipt.state !== "ready" || receipt.writersStopped !== true || receipt.retainedOutput !== "acknowledged") {
      return failure("readiness-receipt", "Maintenance has not issued a ready receipt bound to this owner and data directory");
    }
    return { ok: true, value: "maintenance-receipt" };
  } catch (error) { return ioFailure("readiness-receipt", error); }
}

function writerCensus(configuration, nativePaths, procRoot, nativeRunnerPids) {
  try {
    let count = 0;
    for (const name of readdirSync(procRoot)) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      if (++count > LIMIT) return failure("census-limit", "Process census exceeds bounded startup limit");
      const path = join(procRoot, name);
      try {
        if (lstatSync(path).uid !== configuration.uid || nativeRunnerPids.has(Number(name))) continue;
        const args = readFileSync(join(path, "cmdline"), "utf8").split("\0").filter(Boolean);
        if (Number(name) === process.ppid && args.some(arg => /(?:^|\/)(?:pi-remote-launch|native-history-startup-legacy\.mjs)$/.test(arg))) continue;
        const native = args.some(arg => /(?:runner-host\.(?:js|ts)|(?:shared-)?runtime-host\.(?:mjs|ts)|native-(?:host|guardian)\.mjs|pi-coding-agent\/dist\/(?:bundle\/)?cli\.js)$/.test(arg));
        const supervisor = args.some(arg => /(?:^|\/)server\/(?:main|rooms-main)\.ts$/.test(arg));
        if (!native && !supervisor) continue;
        const scopedArgs = args.some(arg => nativePaths.has(arg) || arg.startsWith(configuration.dataDir + "/") || arg.startsWith(configuration.socketDir + "/"));
        const env = new Map(readFileSync(join(path, "environ"), "utf8").split("\0").filter(Boolean).map(item => {
          const index = item.indexOf("="); return [item.slice(0, index), item.slice(index + 1)];
        }));
        if (scopedArgs || env.get("PI_REMOTE_DATA") === configuration.dataDir || env.get("PI_REMOTE_CONFIG") === configuration.configPath || nativePaths.has(env.get("PI_SESSION_FILE"))) {
          return failure("writers-active", `Owner native/supervisor writer PID ${name} remains; drain through its old controller before startup`);
        }
      } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) return ioFailure("writer-census-unavailable", error); }
    }
    return { ok: true };
  } catch (error) { return ioFailure("writer-census-unavailable", error); }
}

async function controlStatus(path, allowNative) {
  return await new Promise(resolveResult => {
    const socket = createConnection(path);
    const done = result => { socket.destroy(); resolveResult(result); };
    let buffer = "";
    socket.setTimeout(150, () => done(failure("writer-census-unavailable", `Native control did not answer bounded status probe: ${path}`)));
    socket.once("connect", () => {
      if (!allowNative) done(failure("writers-active", `Native runner still listens: ${path}`));
      else socket.write('{"type":"status"}\n');
    });
    socket.on("data", bytes => {
      buffer += bytes;
      if (buffer.length > 64 * 1024) return done(failure("writer-census-unavailable", "Native control status exceeds 64 KiB"));
      if (!buffer.includes("\n")) return;
      try {
        const status = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        done(status.ok === true && status.historySource === "native-jsonl-v1" && Number.isSafeInteger(status.pid) && status.pid > 0
          ? { ok: true, value: { pid: status.pid, generation: path.slice(path.lastIndexOf("/") + 1, -5) } }
          : failure("writers-active", `Legacy or unknown native runner remains: ${path}`));
      } catch (error) { done(ioFailure("writer-census-unavailable", error)); }
    });
    socket.once("end", () => done(failure("writer-census-unavailable", `Native control closed before status receipt: ${path}`)));
    socket.once("error", error => done(["ENOENT", "ECONNREFUSED"].includes(error.code) ? { ok: true, value: null } : ioFailure("writer-census-unavailable", error)));
  });
}

async function outputCensus(configuration, socketDirs, allowNative, procRoot) {
  try {
    const controls = [], artifacts = [];
    for (const root of socketDirs) {
      for (const directory of [join(root, "thread-runners"), join(root, "thread-sockets")]) {
        const checked = inspectPath(directory, configuration.uid, "directory");
        if (!checked.ok) return checked;
        if (!checked.value) continue;
        for (const name of readdirSync(directory)) {
          const path = join(directory, name), info = lstatSync(path);
          if (info.uid !== configuration.uid || info.isSymbolicLink()) return failure("source-ownership", `Native custody artifact is not owned by this user: ${path}`, 78);
          if (name.endsWith(".events")) {
            if (!info.isFile() || info.nlink !== 1) return failure("retained-output", `Retained native output is not a singly linked file: ${path}`);
            artifacts.push({ path, generation: name.slice(0, 16), output: info.size !== 0 });
          } else if (name.endsWith(".sock")) {
            if (!info.isSocket()) return failure("runner-custody", `Native socket has an unexpected file type: ${path}`);
            if (directory.endsWith("/thread-runners")) controls.push(path);
            else artifacts.push({ path, generation: name.slice(0, 16), output: false, socket: true });
          } else if (!name.endsWith(".sock.lock") || !info.isFile()) return failure("runner-custody", `Unrecognized native custody artifact: ${path}`);
          if (controls.length + artifacts.length > 2_000) return failure("census-limit", "Native custody census exceeds bounded startup limit");
        }
      }
    }
    const results = await Promise.all(controls.map(path => controlStatus(path, allowNative)));
    const rejected = results.find(result => !result.ok);
    if (rejected) return rejected;
    const nativeRunnerPids = new Set(), generations = new Set();
    for (const result of results) if (result.value) {
      nativeRunnerPids.add(result.value.pid); generations.add(result.value.generation);
    }
    for (const artifact of artifacts) {
      if (allowNative && generations.has(artifact.generation)) continue;
      if (artifact.output) return failure("retained-output", `Unacknowledged native output remains at ${artifact.path}; drain through the old controller`);
      if (artifact.socket) {
        const live = readFileSync(join(procRoot, "net/unix"), "utf8").split("\n").some(line => {
          const match = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line.trim());
          return match?.[1] === artifact.path;
        });
        if (live) return failure("writers-active", `Native session socket remains live: ${artifact.path}`);
      }
    }
    return { ok: true, value: nativeRunnerPids };
  } catch (error) { return ioFailure("output-census-unavailable", error); }
}

export async function nativeHistoryStartup({ configPath, environment = process.env, uid = process.getuid(), procRoot = "/proc", migrationTimeoutMs = MIGRATION_MS,
  migratorPath = fileURLToPath(new URL("../scripts/migrate-native-history.mjs", import.meta.url)),
  releaseRoot = fileURLToPath(new URL("..", import.meta.url)), manifestRoot = "/srv/pi/.pi-stack-maintenance/native-history" }) {
  if (!NODE_24) return failure("node-version", "Native history startup requires Node 24", 78);
  if (uid !== process.getuid()) return failure("source-ownership", "Startup must run as the actual data owner", 78);
  const parsed = startupConfiguration(configPath, environment, uid);
  if (!parsed.ok) return parsed;
  const configuration = parsed.value;
  const supervisor = inspectPath(configuration.supervisorDb, uid, "file");
  if (!supervisor.ok) return supervisor;
  if (!supervisor.value) return { ok: true, value: { state: "fresh-owner" } };
  const schema = schemaState(configuration.supervisorDb);
  if (!schema.ok) return schema;
  const migrationRequired = schema.value === "migration-required";
  const threads = inspectPath(configuration.threadDb, uid, "file");
  if (!threads.ok) return threads;
  if (!threads.value && schema.value !== "native-schema") return failure("thread-database-missing", "Supervisor has no owning thread mapping database; preserve it and repair maintenance", 78);
  const paths = threads.value ? retainedPaths(configuration) : { ok: true, value: { nativePaths: new Set(), socketDirs: new Set([configuration.socketDir, configuration.dataDir]) } };
  if (!paths.ok) return paths;
  const receipt = migrationRequired ? readinessReceipt(configuration) : { ok: true, value: "not-required" };
  if (!receipt.ok) return receipt;
  const bootstrapIfNeeded = result => {
    if (!migrationRequired || !["writers-active", "retained-output"].includes(result.error.code)) return result;
    const source = legacySourceManifest({ releaseRoot, manifestRoot });
    return source.ok ? { ok: false, error: { code: "legacy-required", message: "Retained old producers require their source-bound maintenance controller before native history migration", exitCode: 76,
      cause: result.error.code, bootstrap: { ...source.value, uid, dataDir: configuration.dataDir } } }
      : { ...result, error: { ...result.error, legacyBootstrapError: source.error } };
  };
  const output = await outputCensus(configuration, paths.value.socketDirs, !migrationRequired, procRoot);
  if (!output.ok) return bootstrapIfNeeded(output);
  const writers = writerCensus(configuration, paths.value.nativePaths, procRoot, output.value);
  if (!writers.ok) return bootstrapIfNeeded(writers);
  if (!migrationRequired) return { ok: true, value: { state: schema.value } };
  if (!isAbsolute(migratorPath) || !Number.isSafeInteger(migrationTimeoutMs) || migrationTimeoutMs <= 0 || migrationTimeoutMs > MIGRATION_MS) return failure("arguments", "Absolute migrator path and positive timeout no greater than 45 seconds required", 78);
  const result = spawnSync(process.execPath, [migratorPath, "--supervisor-db", configuration.supervisorDb, "--thread-db", configuration.threadDb,
    "--output-dir", configuration.outputDir, "--writers-stopped"], { encoding: "utf8", timeout: migrationTimeoutMs, maxBuffer: 1024 * 1024 });
  if (result.error) return ioFailure(result.error.code === "ETIMEDOUT" ? "migration-timeout" : "migration-execution", result.error);
  let migrated;
  try { migrated = JSON.parse(result.stdout.trim()); }
  catch { return failure("migration-protocol", `Migrator failed to return a receipt (exit ${result.status}, signal ${result.signal})`, 78); }
  if (!migrated.ok) return failure(`migration-${migrated.error?.code ?? "protocol"}`, migrated.error?.message ?? "Migrator returned an invalid error receipt", 78);
  if (result.status !== 0 || migrated.value?.state !== "complete") return failure("migration-protocol", "Migrator success receipt is incomplete", 78);
  return { ok: true, value: { state: "migrated", readiness: receipt.value, migration: migrated.value } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = process.argv.length !== 2
    ? failure("arguments", "Use PI_REMOTE_CONFIG and the owner's configured PI_REMOTE_DATA; no CLI arguments", 78)
    : await nativeHistoryStartup({ configPath: process.env.PI_REMOTE_CONFIG });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = result.error.exitCode;
}
