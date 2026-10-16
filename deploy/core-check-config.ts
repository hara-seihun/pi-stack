#!/usr/bin/env bun
import { loadCoreConfig } from "../packages/orchestrator/src/core/config.js";
import { authorizeRelatedImageScope } from "../packages/orchestrator/src/core/image-scopes.js";
if (process.argv.length !== 3) {
  console.log(JSON.stringify({ ok: false, error: { code: "invalid-request", message: "Usage: core-check-config ABSOLUTE_CONFIG" } }));
  process.exitCode = 2;
} else {
  let result = loadCoreConfig(process.argv[2]!);
  if (result.ok && result.value.images.kind === "configured") {
    const config = result.value;
    for (const registry of result.value.images.registries) {
      for (const id of registry.relatedThreadScopeIds) {
        const related = authorizeRelatedImageScope(config, registry.scopeId, id);
        if (!related.ok) { result = { ok: false, error: { ...related.error, message: `${registry.scopeId} → ${id}: ${related.error.message}` } }; break; }
      }
      if (!result.ok) break;
    }
  }
  console.log(JSON.stringify(result.ok ? { ok: true, value: { releaseCommit: result.value.releaseCommit, scopes: result.value.scopes.length, principals: result.value.principals.length, configured: { images: result.value.images.kind, duties: result.value.duties.kind, memory: result.value.memory.kind, broker: result.value.broker.kind } } } : result));
  if (!result.ok) process.exitCode = 1;
}
