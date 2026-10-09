import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";

export function checkParallelism(env = process.env) {
  const budget = Number(env.PI_STACK_CHECK_CONCURRENCY ?? Math.min(4, availableParallelism()));
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error("PI_STACK_CHECK_CONCURRENCY must be a positive integer");
  return budget;
}

export function runJob([name, command, args, options = {}], write = (text) => process.stdout.write(text)) {
  const { timeoutMs = 120_000, drainTimeoutMs = 5_000, dependsOn = [], ...spawnOptions } = options;
  if (dependsOn.length) throw new Error(`runJob cannot admit ${name} without its check graph`);
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const child = spawn(command, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
    let drain;
    let exited;
    let settled = false;
    write(`\n===== ${name}: started =====\n`);
    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(drain);
      child.stdout.destroy();
      child.stderr.destroy();
      const elapsedMs = performance.now() - startedAt;
      if (error) write(`\n${name}: ${error}\n`);
      write(`\n===== ${name}: ${code === 0 ? "passed" : "failed"} (${(elapsedMs / 1000).toFixed(2)}s) =====\n`);
      resolve({ name, outcome: code === 0 ? "passed" : "failed", code, signal, error, elapsedMs });
    };
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      finish(1, "SIGKILL", `exceeded ${timeoutMs}ms deadline`);
    }, timeoutMs);
    const closed = () => {
      if (exited && child.stdout.destroyed && child.stderr.destroyed) {
        finish(exited.code, exited.signal);
      }
    };
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", chunk => write(`[${name}] ${chunk}`));
      stream.on("close", closed);
    }
    child.on("error", error => finish(1, null, error.message));
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      closed();
      if (!settled) drain = setTimeout(() => {
        finish(1, signal, `process exited but descendants still hold its output streams after ${drainTimeoutMs}ms`);
      }, drainTimeoutMs);
    });
  });
}

export async function runJobs(jobs, { concurrency = checkParallelism(), write } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  const workers = Math.min(concurrency, jobs.length);
  const childBudget = Math.max(1, Math.floor(concurrency / Math.max(1, workers)));
  const byName = new Map();
  for (const [index, [name]] of jobs.entries()) {
    if (byName.has(name)) throw new Error(`duplicate check job: ${name}`);
    byName.set(name, index);
  }
  const dependencies = jobs.map(([name, , , { dependsOn = [] } = {}]) => {
    if (!Array.isArray(dependsOn)) throw new Error(`invalid dependencies for ${name}`);
    return dependsOn.map(dependency => {
      if (!byName.has(dependency)) throw new Error(`unknown prerequisite ${dependency} for ${name}`);
      return byName.get(dependency);
    });
  });
  const visiting = new Set(), visited = new Set();
  const visit = index => {
    if (visiting.has(index)) throw new Error(`cyclic check prerequisites at ${jobs[index][0]}`);
    if (visited.has(index)) return;
    visiting.add(index);
    dependencies[index].forEach(visit);
    visiting.delete(index);
    visited.add(index);
  };
  jobs.forEach((_, index) => visit(index));

  const results = new Array(jobs.length);
  const pending = new Set(jobs.map((_, index) => index));
  const running = new Map();
  while (pending.size || running.size) {
    for (const index of pending) {
      const [name, command, args, { dependsOn, ...options } = {}] = jobs[index];
      const failed = dependencies[index].filter(dependency => results[dependency] && results[dependency].outcome !== "passed");
      if (failed.length) {
        const blockedBy = failed.map(dependency => jobs[dependency][0]);
        const error = `prerequisites did not pass: ${blockedBy.join(", ")}`;
        results[index] = { name, outcome: "blocked", code: 1, signal: null, error, blockedBy, elapsedMs: 0 };
        (write ?? (text => process.stdout.write(text)))(`\n===== ${name}: blocked (${error}) =====\n`);
        pending.delete(index);
      } else if (running.size < workers && dependencies[index].every(dependency => results[dependency]?.outcome === "passed")) {
        const env = { ...process.env, ...options.env, PI_STACK_CHECK_CONCURRENCY: String(childBudget) };
        running.set(index, runJob([name, command, args, { ...options, env }], write).then(result => ({ index, result })));
        pending.delete(index);
      }
    }
    if (running.size) {
      const { index, result } = await Promise.race(running.values());
      results[index] = result;
      running.delete(index);
    }
  }
  if (results.some(result => result.code !== 0)) process.exitCode = 1;
  return results;
}
