#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, rmSync, lstatSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const pause = new Int32Array(new SharedArrayBuffer(4));
const failure = (code, message) => ({ state: "failed", error: { code, message } });
const ioError = error => ({ code: "source-job-io", message: `source job state operation failed (${error.code ?? "invalid-state"})` });

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  throw Object.assign(new Error("not JSON"), { code: "invalid-json" });
}

function atomicJson(filename, value, exclusive = false) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${canonical(value)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (exclusive) linkSync(temporary, filename);
    else renameSync(temporary, filename);
    const directory = openSync(path.dirname(filename), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function readJson(filename) {
  try { return { present: true, value: JSON.parse(readFileSync(filename, "utf8")) }; }
  catch (error) {
    if (error.code === "ENOENT") return { present: false };
    throw error;
  }
}

function terminal(value) {
  if (value?.state === "ready" && Object.hasOwn(value, "value")) {
    canonical(value.value);
    return { state: "ready", value: value.value };
  }
  if (value?.state === "failed" && typeof value.error?.code === "string" && value.error.code.length > 0
    && typeof value.error.message === "string" && value.error.message.length > 0) {
    return { state: "failed", error: { code: value.error.code, message: value.error.message } };
  }
  throw Object.assign(new Error("invalid terminal result"), { code: "invalid-result" });
}

export function readSourceJobRequest(directory) {
  try {
    const request = readJson(path.join(directory, "request.json"));
    return request.present ? { ok: true, value: request.value }
      : { ok: false, error: { code: "source-job-request-missing", message: "source job request is absent" } };
  } catch (error) { return { ok: false, error: ioError(error) }; }
}

export function writeSourceJobProgress(directory, value) {
  try {
    if (readTerminal(directory)) return { ok: false, error: { code: "source-job-completed", message: "terminal source job cannot publish running progress" } };
    const attempt = readJson(path.join(directory, "attempt.json"));
    if (!attempt.present) return { ok: false, error: { code: "source-job-not-started", message: "source job attempt is absent" } };
    atomicJson(path.join(directory, "progress.json"), {
      state: "running", attempt: attempt.value.number, updatedAt: new Date().toISOString(), value,
    });
    return { ok: true };
  } catch (error) { return { ok: false, error: ioError(error) }; }
}

export function finishSourceJob(directory, result) {
  try {
    const value = terminal(result);
    const filename = path.join(directory, "result.json");
    try { atomicJson(filename, value, true); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const recorded = readJson(filename);
      if (!recorded.present || canonical(terminal(recorded.value)) !== canonical(value)) {
        return { ok: false, error: { code: "source-job-result-conflict", message: "source job already has a different terminal result" } };
      }
    }
    atomicJson(path.join(directory, "progress.json"), value);
    return { ok: true };
  } catch (error) { return { ok: false, error: ioError(error) }; }
}

export function observeSourceJob(directory) {
  try {
    const result = readTerminal(directory);
    if (result) return result;
    const request = readSourceJobRequest(directory);
    if (!request.ok) return { state: "failed", error: request.error };
    const attempt = readJson(path.join(directory, "attempt.json"));
    if (!attempt.present || typeof attempt.value.unit !== "string") {
      return failure("source-job-not-started", "source job attempt is absent or invalid");
    }
    const observed = unitState(attempt.value.unit);
    // Completion may race with unit observation; its immutable result wins.
    const completed = readTerminal(directory);
    if (completed) return completed;
    if (!observed.ok) return { state: "failed", error: observed.error };
    if (observed.state !== "running" && observed.state !== "stopping") return {
      state: "interrupted", error: { code: "source-job-interrupted", message: "source job stopped without a terminal result; repeat the original create request to resume" },
    };
    const progress = readJson(path.join(directory, "progress.json"));
    return { state: "pending", phase: observed.state, progress: progress.present ? progress.value : null };
  } catch (error) { return { state: "failed", error: ioError(error) }; }
}

export function userManagerEnvironment(environment = process.env) {
  const invalid = message => ({ ok: false, error: { code: "source-job-user-environment", message } });
  if (typeof process.geteuid !== "function") return invalid("systemd user jobs require a Unix effective user");
  const uid = process.geteuid();
  const runtime = environment.XDG_RUNTIME_DIR === undefined ? `/run/user/${uid}` : environment.XDG_RUNTIME_DIR;
  if (typeof runtime !== "string" || !path.isAbsolute(runtime) || runtime.includes("\0")) {
    return invalid("XDG_RUNTIME_DIR must name the effective user's absolute runtime directory");
  }
  try {
    const directory = lstatSync(runtime);
    if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0) {
      return invalid("systemd runtime directory must be private and owned by the effective user");
    }
    let address = environment.DBUS_SESSION_BUS_ADDRESS;
    if (address === undefined) {
      const bus = path.join(runtime, "bus");
      const socket = lstatSync(bus);
      if (!socket.isSocket() || socket.uid !== uid) {
        return invalid("systemd user bus must be an existing socket owned by the effective user");
      }
      address = `unix:path=${bus}`;
    } else if (typeof address !== "string" || address.length === 0 || address.includes("\0")) {
      return invalid("DBUS_SESSION_BUS_ADDRESS is explicitly set but invalid");
    }
    return { ok: true, value: { ...environment, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: address } };
  } catch (error) {
    return invalid(`systemd user environment is unavailable (${error.code ?? "invalid-state"}); no job was submitted`);
  }
}

function systemCommand(executable, args) {
  const environment = userManagerEnvironment();
  if (!environment.ok) return environment;
  const result = spawnSync(executable, args, { env: environment.value, encoding: "utf8", timeout: 2500, maxBuffer: 64 * 1024 });
  if (result.error?.code === "ENOENT") return { ok: false, error: {
    code: "source-job-unsupported", message: `${executable} is required for durable source preparation`,
  } };
  if (result.error?.code === "ETIMEDOUT") return { ok: false, error: {
    code: "source-job-control-timeout", message: "systemd source job control timed out; repeat the request to reconcile durable state",
  } };
  if (result.error) return { ok: false, error: { code: "source-job-control-failed", message: "systemd source job control could not execute" } };
  return { ok: true, status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function unitState(unit) {
  const result = systemCommand("systemctl", ["--user", "show", unit, "--property=LoadState,ActiveState,SubState,Result,ExecMainStatus"]);
  if (!result.ok) return result;
  // A missing unit still produces LoadState=not-found. A missing user bus produces no properties.
  const properties = Object.fromEntries(result.stdout.trim().split("\n").filter(line => line.includes("=")).map(line => {
    const split = line.indexOf("=");
    return [line.slice(0, split), line.slice(split + 1)];
  }));
  if (!properties.LoadState || !properties.ActiveState) return { ok: false, error: {
    code: "source-job-unsupported", message: "a reachable systemd user manager is required for durable source preparation",
  } };
  if (properties.LoadState === "not-found") return { ok: true, state: "absent", properties };
  if (properties.LoadState !== "loaded") return { ok: false, error: {
    code: "source-job-control-failed", message: `source preparation unit is ${properties.LoadState}`,
  } };
  switch (properties.ActiveState) {
    case "active": case "activating": case "reloading": case "refreshing":
      return { ok: true, state: "running", properties };
    case "inactive": case "failed":
      return { ok: true, state: "stopped", properties };
    case "deactivating":
      return { ok: true, state: "stopping", properties };
    default:
      return { ok: false, error: { code: "source-job-control-failed", message: "unknown systemd source preparation state" } };
  }
}

function pending(jobId, directory, phase) {
  return { state: "pending", jobId, progressPath: path.join(directory, "progress.json"), resultPath: path.join(directory, "result.json"), phase };
}

function readTerminal(directory) {
  const result = readJson(path.join(directory, "result.json"));
  return result.present ? terminal(result.value) : undefined;
}

export function sourceJobId(key, request) {
  return createHash("sha256").update(canonical({ key, request })).digest("hex");
}

/** Sync, bounded submission/observation; only systemd owns the preparation process tree. */
export function runSourceJob({ directory, key, request, command, env = {}, waitMs = 2000, restartInterrupted = false, cleanupCommand = [], restartAbnormal = false }) {
  let database;
  let locked = false;
  try {
    if (typeof directory !== "string" || !path.isAbsolute(directory) || typeof key !== "string" || !key
      || !Array.isArray(command) || !command.length || !path.isAbsolute(command[0])
      || command.some(value => typeof value !== "string" || value.includes("\0"))
      || !Array.isArray(cleanupCommand) || cleanupCommand.some(value => typeof value !== "string" || /[\0\r\n]/u.test(value))
      || (cleanupCommand.length > 0 && !path.isAbsolute(cleanupCommand[0]))
      || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 5000 || typeof restartInterrupted !== "boolean" || typeof restartAbnormal !== "boolean"
      || !env || Object.getPrototypeOf(env) !== Object.prototype
      || Object.entries(env).some(([name, value]) => !/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)
        || typeof value !== "string" || value.includes("\0"))) {
      return failure("source-job-invalid-request", "source job requires an absolute registry directory, key, JSON request, absolute command, string environment and bounded waitMs (0–5000)");
    }
    try { canonical({ key, request }); }
    catch { return failure("source-job-invalid-request", "source job request must contain only finite JSON values"); }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const root = realpathSync(directory);
    const jobId = sourceJobId(key, request);
    const jobDirectory = path.join(root, jobId);
    mkdirSync(jobDirectory, { recursive: true, mode: 0o700 });
    chmodSync(jobDirectory, 0o700);
    const lockPath = path.join(jobDirectory, "lock.sqlite3");
    const descriptor = openSync(lockPath, "a", 0o600);
    closeSync(descriptor);
    chmodSync(lockPath, 0o600);
    database = new DatabaseSync(lockPath);
    try { database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); locked = true; }
    catch (error) {
      if (error.errcode === 5 || error.code === "SQLITE_BUSY") return pending(jobId, jobDirectory, "submitting");
      throw error;
    }
    const requestPath = path.join(jobDirectory, "request.json");
    const oldRequest = readJson(requestPath);
    if (oldRequest.present && canonical(oldRequest.value) !== canonical(request)) {
      return failure("source-job-identity-conflict", "source job identity does not match its recorded request");
    }
    if (!oldRequest.present) atomicJson(requestPath, request);
    const recorded = readTerminal(jobDirectory);
    if (recorded) return recorded;
    const commandPath = path.join(jobDirectory, "command.json");
    const oldCommand = readJson(commandPath);
    if (oldCommand.present && canonical(oldCommand.value) !== canonical(command)) {
      return failure("source-job-command-conflict", "the same source job cannot change its worker command");
    }
    if (!oldCommand.present) atomicJson(commandPath, command);
    let attempt = readJson(path.join(jobDirectory, "attempt.json"));
    if (attempt.present) {
      if (!Number.isSafeInteger(attempt.value.number) || attempt.value.number < 1 || typeof attempt.value.unit !== "string"
        || !["submitting", "submitted"].includes(attempt.value.state)) {
        return failure("source-job-invalid-state", "source job attempt metadata is invalid");
      }
      const observed = unitState(attempt.value.unit);
      if (!observed.ok) return { state: "failed", error: observed.error };
      const completed = readTerminal(jobDirectory);
      if (completed) return completed;
      if (observed.state === "running" || observed.state === "stopping") {
        return pending(jobId, jobDirectory, observed.state);
      }
      if (!restartInterrupted) return {
        state: "interrupted", jobId, progressPath: path.join(jobDirectory, "progress.json"),
        error: { code: "source-job-interrupted", message: "source preparation unit stopped without a terminal result; repeat with restartInterrupted to resume the same job" },
      };
    }
    const environmentPath = path.join(jobDirectory, "environment.json");
    const managerEnvironment = userManagerEnvironment();
    if (!managerEnvironment.ok) return { state: "failed", error: managerEnvironment.error };
    atomicJson(environmentPath, { ...managerEnvironment.value, ...env });
    const number = attempt.present ? attempt.value.number + 1 : 1;
    const namespace = createHash("sha256").update(root).digest("hex").slice(0, 16);
    const unit = `pi-workspace-source-${namespace}-${jobId}-a${number}.service`;
    const attemptPath = path.join(jobDirectory, "attempt.json");
    atomicJson(attemptPath, { number, unit, state: "submitting" });
    atomicJson(path.join(jobDirectory, "progress.json"), {
      state: "starting", attempt: number, updatedAt: new Date().toISOString(), value: null,
    });
    const submitted = systemCommand("systemd-run", [
      "--user", "--quiet", "--collect", `--unit=${unit}`, "--service-type=exec",
      `--property=Restart=${restartAbnormal ? "on-abnormal" : "no"}`, "--property=RestartSec=1s",
      "--property=KillMode=control-group", "--property=UMask=0077",
      "--property=StandardOutput=null", "--property=StandardError=null",
      ...(cleanupCommand.length ? [`--property=ExecStopPost=${cleanupCommand.map(value =>
        `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`).join(" ")}`] : []),
      "--", process.execPath, modulePath, "--worker", jobDirectory,
    ]);
    if (!submitted.ok) return { state: "failed", error: submitted.error };
    if (submitted.status !== 0) {
      const observed = unitState(unit);
      if (!observed.ok) return { state: "failed", error: observed.error };
      if (observed.state !== "running") {
        const completed = readTerminal(jobDirectory);
        return completed ?? failure("source-job-submit-failed", "systemd did not accept the source preparation job; durable state retained for reconciliation");
      }
    }
    atomicJson(attemptPath, { number, unit, state: "submitted" });
    database.exec("COMMIT");
    locked = false;
    database.close();
    database = undefined;
    const deadline = Date.now() + waitMs;
    // This is the deliberately bounded fast-create path, not a lifetime monitor.
    do {
      const completed = readTerminal(jobDirectory);
      if (completed) return completed;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      Atomics.wait(pause, 0, 0, Math.min(20, remaining));
    } while (true);
    const observed = unitState(unit);
    if (!observed.ok) return { state: "failed", error: observed.error };
    const completed = readTerminal(jobDirectory);
    if (completed) return completed;
    if (observed.state === "running" || observed.state === "stopping") return pending(jobId, jobDirectory, observed.state);
    return {
      state: "interrupted", jobId, progressPath: path.join(jobDirectory, "progress.json"),
      error: { code: "source-job-interrupted", message: "source preparation unit stopped without a terminal result" },
    };
  } catch (error) { return { state: "failed", error: ioError(error) }; }
  finally {
    if (database) {
      if (locked) database.exec("ROLLBACK");
      database.close();
    }
  }
}

async function sourceWorker(directory) {
  try {
    if (readTerminal(directory)) return { ok: true };
    const command = readJson(path.join(directory, "command.json"));
    const environment = readJson(path.join(directory, "environment.json"));
    if (!command.present || !environment.present) return finishSourceJob(directory,
      failure("source-job-worker-input-missing", "source worker command or environment is absent"));
    const progress = writeSourceJobProgress(directory, { phase: "preparing" });
    if (!progress.ok) return progress;
    const exit = await new Promise(resolve => {
      const child = spawn(command.value[0], command.value.slice(1), {
        cwd: environment.value.HOME,
        env: { ...environment.value, PI_WORKSPACE_SOURCE_JOB_DIR: directory },
        stdio: "ignore",
      });
      child.once("error", () => resolve({ kind: "spawn-failed" }));
      child.once("exit", (code, signal) => resolve({ kind: "exit", code, signal }));
    });
    const completed = readTerminal(directory);
    if (completed) return { ok: true };
    if (exit.kind === "exit" && exit.signal !== null) return { ok: false, error: {
      code: "source-job-interrupted", message: `source preparation worker was interrupted by ${exit.signal}`,
    } };
    return finishSourceJob(directory, failure(
      exit.kind === "spawn-failed" ? "source-job-worker-spawn-failed" : "source-job-worker-no-result",
      exit.kind === "spawn-failed" ? "source preparation worker could not start"
        : `source preparation worker exited without a terminal result (exit ${exit.code}, signal ${exit.signal})`,
    ));
  } catch (error) { return finishSourceJob(directory, { state: "failed", error: ioError(error) }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  if (process.argv.length !== 4 || process.argv[2] !== "--worker" || !path.isAbsolute(process.argv[3])) process.exitCode = 2;
  else {
    const result = await sourceWorker(process.argv[3]);
    if (!result.ok) process.exitCode = 1;
  }
}
