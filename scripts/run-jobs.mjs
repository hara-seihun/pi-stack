import { spawn } from "node:child_process";

export function runJob([name, command, args, options = {}], write = (text) => process.stdout.write(text)) {
  const { timeoutMs = 120_000, drainTimeoutMs = 250, ...spawnOptions } = options;
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const child = spawn(command, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
    let drain;
    let exited;
    let settled = false;
    let timedOut = false;
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
      resolve({ name, code, signal, error, elapsedMs });
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const closed = () => {
      if (exited && child.stdout.destroyed && child.stderr.destroyed) {
        finish(timedOut ? 1 : exited.code, exited.signal, timedOut ? `exceeded ${timeoutMs}ms deadline` : undefined);
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
        finish(1, signal, timedOut ? `exceeded ${timeoutMs}ms deadline` : "process exited but descendants still hold its output streams");
      }, drainTimeoutMs);
    });
  });
}

export async function runJobs(jobs) {
  const results = await Promise.all(jobs.map(job => runJob(job)));
  if (results.some(result => result.code !== 0)) process.exitCode = 1;
  return results;
}
