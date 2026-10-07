#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runStackAgent } from "./stack-agent.mjs";

const cli = fileURLToPath(new URL("./node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const args = process.argv.slice(2);
try {
  // These exact invocations never construct an executing session.
  if (args.length === 1 && ["--help", "-h", "--version", "-v"].includes(args[0])) {
    const result = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } else process.exitCode = await runStackAgent(process.execPath, [cli, ...args]);
} catch (error) { console.error(error.message); process.exitCode = 1; }
