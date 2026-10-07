#!/usr/bin/env node
import { openSync, writeFileSync, fsyncSync, closeSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const [directory, candidateCommit] = process.argv.slice(2);
if (!isAbsolute(directory ?? "") || !/^[a-f0-9]{40}$/.test(candidateCommit ?? "") || !/^[a-f0-9]{32}$/.test(process.env.INVOCATION_ID ?? "")) throw new Error("Explicit durable job/commit/invocation identity required");
const receipt = { version: 1, candidateCommit, invocationId: process.env.INVOCATION_ID, serviceResult: process.env.SERVICE_RESULT,
  exitCode: process.env.EXIT_CODE, exitStatus: process.env.EXIT_STATUS, settledAt: new Date().toISOString() };
const fd = openSync(join(directory, `receipt-${receipt.invocationId}.json`), "wx", 0o600);
try { writeFileSync(fd, JSON.stringify(receipt) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
const parent = openSync(directory, "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
console.log(JSON.stringify(receipt));
