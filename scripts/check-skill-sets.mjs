import { readdir, readFile, stat } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("config/skill-sets.json", root), "utf8"));
if (manifest.version !== 1) throw new Error("Unknown skill-set manifest version");
if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) throw new Error("No skills declared");
const declared = new Set(manifest.skills);
if (declared.size !== manifest.skills.length) throw new Error("Duplicate skill declaration");
for (const skill of manifest.skills) {
  const path = new URL(`skills/${skill}/SKILL.md`, root);
  if (!(await stat(path)).isFile()) throw new Error(`${skill} has no SKILL.md`);
}
const actual = (await readdir(new URL("skills", root), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const expected = [...declared].sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`Skill manifest mismatch: declared ${expected.join(", ")}; found ${actual.join(", ")}`);
}
for (const [role, skills] of Object.entries(manifest.roles)) {
  if (!Array.isArray(skills) || skills.length === 0) throw new Error(`${role} has no skills`);
  const seen = new Set();
  for (const skill of skills) {
    if (!declared.has(skill)) throw new Error(`${role} names unknown skill ${skill}`);
    if (seen.has(skill)) throw new Error(`${role} repeats skill ${skill}`);
    seen.add(skill);
  }
}
console.log(`checked ${manifest.skills.length} skills across ${Object.keys(manifest.roles).length} roles`);
