import { spawn } from "node:child_process";

export async function runJobs(jobs) {
  const results = await Promise.all(jobs.map(([name, command, args, options = {}]) => new Promise((resolve) => {
    const startedAt = performance.now();
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => resolve({ name, code: null, signal: null, output: `${output}${error.message}\n`, elapsedMs: performance.now() - startedAt }));
    child.on("exit", (code, signal) => resolve({ name, code, signal, output, elapsedMs: performance.now() - startedAt }));
  })));

  let failed = false;
  for (const result of results) {
    process.stdout.write(`\n===== ${result.name} (${(result.elapsedMs / 1_000).toFixed(2)}s) =====\n${result.output}`);
    if (result.code !== 0) {
      failed = true;
      const outcome = result.signal ? `signal ${result.signal}` : `exit ${result.code ?? "unknown"}`;
      process.stderr.write(`${result.name} failed with ${outcome}\n`);
    }
  }
  if (failed) process.exitCode = 1;
}
