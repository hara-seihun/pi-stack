import { spawn } from "node:child_process";

const jobs = [
  ["package sets", "node", ["scripts/check-package-sets.mjs"]],
  ["skill deployment", "node", ["--test", "scripts/deploy-skills.test.mjs"]],
  ["deploy lock", "node", ["--test", "scripts/deploy-lock.test.mjs"]],
  ["tools", "node", ["scripts/check-tools.mjs"]],
  ["agent workspace", "npm", ["test", "--workspace=@hara-seihun/agent-workspace"]],
  ["runtime", "npm", ["test", "--workspace=@hara-seihun/pi-runtime"]],
  ["cursor provider", "npm", ["run", "check", "--workspace=@rahularya01/pi-cursor"]],
  ["orchestrator", "npm", ["test", "--workspace=pi-orchestrator"]],
  ["remote", "npm", ["test", "--workspace=pi-remote"]],
  ["mcp", "npm", ["test", "--workspace=@hara-seihun/mcp-cli"]],
  ["mcp-script", "npm", ["test", "--workspace=@hara-seihun/mcp-script"]],
  ["session reader", "npm", ["test", "--workspace=@hara-seihun/read-condensed-session"]],
];

const results = await Promise.all(jobs.map(([name, command, args]) => new Promise((resolve) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("exit", (code, signal) => resolve({ name, code, signal, output }));
})));

let failed = false;
for (const result of results) {
  process.stdout.write(`\n===== ${result.name} =====\n${result.output}`);
  if (result.code !== 0) {
    failed = true;
    process.stderr.write(`${result.name} failed${result.signal ? ` with ${result.signal}` : ` with exit ${result.code}`}\n`);
  }
}
if (failed) process.exit(1);
