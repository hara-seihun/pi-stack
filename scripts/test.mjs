import { runJobs } from "./run-jobs.mjs";

const jobs = [
  ["job lifecycle", "node", ["--test", "scripts/run-jobs.test.mjs"]],
  ["orchestrator types", "npm", ["run", "typecheck", "--workspace=pi-orchestrator"]],
  ["Kenan build", "npm", ["run", "build", "--workspace=kenan"]],
  ["manifests", "node", ["scripts/check-manifests.mjs"]],
  ["skill deployment", "node", ["--test", "scripts/deploy-skills.test.mjs"]],
  ["deploy lock", "node", ["--test", "scripts/deploy-lock.test.mjs", "scripts/deploy-build.test.mjs", "scripts/release-checkout.test.mjs"]],
  ["publication", "node", ["--test", "scripts/publication.test.mjs", "scripts/publication-gate.test.mjs", "scripts/publication-source.test.mjs", "scripts/publication-progress.test.mjs"]],
  ["remote deployment", "node", ["--test", "scripts/deploy-remote.test.mjs"]],
  ["tools", "node", ["scripts/check-tools.mjs"]],
  ["user usage", "node", ["--test", "tools/user-usage/usage.test.mjs"]],
  ["agent workspace", "npm", ["test", "--workspace=@hara-seihun/agent-workspace"]],
  ["runtime", "npm", ["test", "--workspace=@hara-seihun/pi-runtime"]],
  ["orchestrator", "npm", ["test", "--workspace=pi-orchestrator"]],
  ["remote", "npm", ["test", "--workspace=pi-remote"]],
  ["mcp", "npm", ["test", "--workspace=@hara-seihun/mcp-cli"]],
  ["mcp-script", "npm", ["test", "--workspace=@hara-seihun/mcp-script"]],
  ["session readers", "npm", ["test", "--workspace=@hara-seihun/read-condensed-session"]],
];

await runJobs(jobs);
