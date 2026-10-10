#!/usr/bin/env bun
import { loadCoreConfig } from "../packages/orchestrator/src/core/config.js";
if (process.argv.length !== 3) {
  console.log(JSON.stringify({ ok: false, error: { code: "invalid-request", message: "Usage: core-check-config ABSOLUTE_CONFIG" } }));
  process.exitCode = 2;
} else {
  const result = loadCoreConfig(process.argv[2]!);
  console.log(JSON.stringify(result.ok ? { ok: true, value: { releaseCommit: result.value.releaseCommit, scopes: result.value.scopes.length, principals: result.value.principals.length, configured: { images: result.value.images.kind, duties: result.value.duties.kind, memory: result.value.memory.kind, broker: result.value.broker.kind } } } : result));
  if (!result.ok) process.exitCode = 1;
}
