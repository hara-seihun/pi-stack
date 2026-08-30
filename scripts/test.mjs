import { runJobs } from "./run-jobs.mjs";

const jobs = [
  ["orchestrator types", "npm", ["run", "typecheck", "--workspace=pi-orchestrator"]],
  ["Kenan build", "npm", ["run", "build", "--workspace=kenan"]],
  ["package sets", "node", ["scripts/check-package-sets.mjs"]],
  ["skill sets", "node", ["scripts/check-skill-sets.mjs"]],
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
  ["session readers", "npm", ["test", "--workspace=@hara-seihun/read-condensed-session"]],
];

await runJobs(jobs);
