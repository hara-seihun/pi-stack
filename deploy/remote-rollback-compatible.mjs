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

export function providerRestartCompatibility(release, transitionFile = "/etc/pi-stack/outbound-transport-transition.json") {
  let transition;
  try {
    transition = JSON.parse(readFileSync(transitionFile, "utf8"));
  } catch (cause) {
    if (cause?.code === "ENOENT") return { ok: true };
    return { ok: false, error: "provider boundary unreadable; retain accepting intake and repair forward" };
  }
  if (transition?.version !== 1 || transition.boundary !== "host-declared-provider-v1" || !["installing", "installed"].includes(transition.phase)) {
    return { ok: false, error: "unknown persisted provider boundary; retain accepting intake and repair forward" };
  }
  try {
    const target = JSON.parse(readFileSync(join(release, "provider-contract.json"), "utf8"));
    if (target?.version === 1 && target.rawOutboundProviders === transition.boundary) return { ok: true };
  } catch {}
  return { ok: false, error: `forward-only provider boundary (${transition.phase}); target cannot consume the host declaration, so old-provider restart is forbidden` };
}

export function rollbackCompatibility(selected, previous, transitionFile) {
  const current = contract(selected);
  if (!current.ok) return { ok: false, error: `selected release: ${current.error}` };
  const target = contract(previous);
  if (!target.ok) return { ok: false, error: `rollback release: ${target.error}` };
  if (current.schema !== target.schema) {
    return { ok: false, error: `data contract changed (${current.schema} → ${target.schema})` };
  }
  return providerRestartCompatibility(previous, transitionFile);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4) {
    console.error("usage: remote-rollback-compatible.mjs SELECTED_RELEASE PREVIOUS_RELEASE | --restart RELEASE");
    process.exit(64);
  }
  const result = process.argv[2] === "--restart"
    ? providerRestartCompatibility(process.argv[3])
    : rollbackCompatibility(process.argv[2], process.argv[3]);
  if (!result.ok) {
    console.error(`Remote rollback refused: ${result.error}; retain forward selection and repair it`);
    process.exit(1);
  }
}
