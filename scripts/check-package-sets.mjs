import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../config/package-sets.json", import.meta.url), "utf8"));
if (manifest.version !== 1) throw new Error("Unknown package-set manifest version");
const known = new Set(Object.keys(manifest.packages));
if (!known.has(manifest.contextObserver)) throw new Error("The context observer is not a declared package");
for (const [role, packages] of Object.entries(manifest.roles)) {
  if (!Array.isArray(packages) || packages.length === 0) throw new Error(`${role} has no packages`);
  const seen = new Set();
  for (const name of packages) {
    if (!known.has(name)) throw new Error(`${role} names unknown package ${name}`);
    if (seen.has(name)) throw new Error(`${role} repeats package ${name}`);
    seen.add(name);
  }
  const observer = packages.indexOf(manifest.contextObserver);
  if (observer !== -1 && observer !== packages.length - 1)
    throw new Error(`${role} must load ${manifest.contextObserver} last`);
}
console.log(`checked ${Object.keys(manifest.roles).length} Pi package sets`);
