import { runJobs } from "../../../../../scripts/run-jobs.mjs";

await runJobs([
  ["types", "npm", ["run", "typecheck"]],
  ["lint", "npm", ["run", "lint"]],
  ["format", "npm", ["run", "format:check"]],
  ["security", "npm", ["run", "security-check"]],
  ["protocol", "npm", ["run", "proto:check"]],
  ["tests", "npm", ["test"]],
  ["script tests", "npm", ["run", "test:legacy"]],
]);
