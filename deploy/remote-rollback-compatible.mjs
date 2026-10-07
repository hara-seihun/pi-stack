#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function contract(release) {
  try {
    const value = JSON.parse(readFileSync(join(release, "data-contract.json"), "utf8"));
    if (value.version !== 1 || typeof value.schema !== "string" || !value.schema.trim()) {
      return { ok: false, error: "invalid data contract" };
    }
    return { ok: true, schema: value.schema };
  } catch (cause) {
    return { ok: false, error: String(cause) };
  }
}

export function rollbackCompatibility(selected, previous) {
  const current = contract(selected);
  if (!current.ok) return { ok: false, error: `selected release: ${current.error}` };
  const target = contract(previous);
  if (!target.ok) return { ok: false, error: `rollback release: ${target.error}` };
  if (current.schema !== target.schema) {
    return { ok: false, error: `data contract changed (${current.schema} → ${target.schema})` };
  }
  return { ok: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4) {
    console.error("usage: remote-rollback-compatible.mjs SELECTED_RELEASE PREVIOUS_RELEASE");
    process.exit(64);
  }
  const result = rollbackCompatibility(process.argv[2], process.argv[3]);
  if (!result.ok) {
    console.error(`Remote rollback refused: ${result.error}; retain forward selection and repair it`);
    process.exit(1);
  }
}
