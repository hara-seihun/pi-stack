#!/usr/bin/env node
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { finishSourceJob, writeSourceJobProgress } from "./source-job.mjs";

function clean(staging) {
  if (!path.isAbsolute(staging) || !/^\..+\.creating-[0-9a-f-]{36}(?:-\d+-\d+)?$/.test(path.basename(staging))) {
    throw new Error("invalid checkout staging path");
  }
  rmSync(staging, { recursive: true, force: true });
}

if (process.argv[2] === "--cleanup") {
  clean(process.argv[3]);
} else {
  const [statePath, id, staging, budget, ...args] = process.argv.slice(2);
  const directory = process.env.PI_WORKSPACE_SOURCE_JOB_DIR;
  if (!directory || !path.isAbsolute(statePath) || !Number.isFinite(Number(budget))) {
    throw new Error("invalid checkout job request");
  }
  clean(staging);
  writeSourceJobProgress(directory, { phase: "materializing", id });
  const child = spawn(process.execPath, [new URL("workspace.mjs", import.meta.url).pathname, "create", ...args], {
    cwd: process.env.HOME,
    env: { ...process.env, PI_WORKSPACE_STATE: statePath, PI_WORKSPACE_CREATE_CHILD: statePath,
      PI_WORKSPACE_CHECKOUT_JOB: id, PI_WORKSPACE_CHECKOUT_STAGE: staging },
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", errors = "", interrupted;
  child.stdout.on("data", bytes => { output = (output + bytes).slice(-65536); });
  child.stderr.on("data", bytes => { errors = (errors + bytes).slice(-65536); });
  const stop = reason => {
    interrupted = reason;
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => stop(`interrupted by ${signal}`));
  const timer = setTimeout(() => stop("checkout budget exhausted"), Number(budget) + 1000);
  const exit = await new Promise(resolve => {
    child.once("error", error => resolve({ code: null, error: error.message }));
    child.once("close", (code, signal) => resolve({ code, error: signal }));
  });
  clearTimeout(timer);
  clean(staging);
  const result = exit.code === 0 && !interrupted
    ? { state: "ready", value: { id } }
    : { state: "failed", error: { code: "checkout-materialization-failed",
      message: `${interrupted ?? (errors.trim() || exit.error || `exit ${exit.code}`)}; private staging removed; destination not partially published. Repeat the request; for timeout, raise --creation-timeout-seconds (maximum 86400).` } };
  const finished = finishSourceJob(directory, result);
  if (!finished.ok) throw new Error(finished.error.message);
  if (result.state === "failed") process.exitCode = 1;
}
