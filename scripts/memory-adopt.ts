#!/usr/bin/env bun
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { adoptMarkdown, type AdoptionOptions } from "../packages/kenan-memory/src/adoption.js";

export function runAdoptionPlan(path: string) {
  if (!isAbsolute(path)) return { ok: false, error: { code: "invalid-plan", message: "Use an absolute host-declared adoption plan" } };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return { ok: false, error: { code: "invalid-plan", message: "The adoption plan must be canonical, root-owned and not group/world writable" } };
    const plan = JSON.parse(readFileSync(path, "utf8")) as AdoptionOptions;
    return adoptMarkdown({ ...plan, now: Date.now() });
  } catch { return { ok: false, error: { code: "invalid-plan", message: "Adoption plan is unavailable or invalid" } }; }
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") console.log("Usage: bun scripts/memory-adopt.ts --plan /absolute/root-owned/plan.json\nOne non-destructive read-only source snapshot into a granted Markdown folder. Host plan declares authenticated principal, source/destination resources, person or custody-subject selection and permission policy. Prints only fingerprint/current-head/ownership-path receipt metadata; custody helper supplies explicit target UID/GID. Final adoption follows original-writer drain; expectedAuthority may CAS only its own prior adopted head. See docs/memory-adoption.md. Does not modify grants, source data or uncertain effects.");
  else if (args.length !== 2 || args[0] !== "--plan") { console.error("Use --help for the explicit adoption plan contract"); process.exitCode = 64; }
  else {
    const result = runAdoptionPlan(args[1]!);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  }
}
