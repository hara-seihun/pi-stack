import { readdir, readFile, stat } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

const packages = await read("config/packages.json");
if (packages.version !== 2) throw new Error("Unknown packages manifest version");
const ids = new Set();
for (const entry of packages.packages) {
  if (!/^[a-z][a-z0-9-]*$/.test(entry.id) || ids.has(entry.id)) throw new Error(`invalid or repeated package id: ${entry.id}`);
  ids.add(entry.id);
  if (entry.source.startsWith("npm:") || entry.source.startsWith("git:") || entry.source.includes("://")) {
    if (entry.deployed) throw new Error(`${entry.id} is an external package and has no deployed path`);
    continue;
  }
  if (!(await stat(new URL(`${entry.source}/package.json`, root))).isFile()) throw new Error(`${entry.id} source has no package.json`);
  if (!entry.deployed?.startsWith("/")) throw new Error(`${entry.id} needs an absolute deployed path`);
}
if (packages.packages.at(-1)?.id !== packages.contextObserver) throw new Error(`${packages.contextObserver} must be the last package`);

const skills = await read("config/skills.json");
if (skills.version !== 2) throw new Error("Unknown skills manifest version");
const declared = [...skills.skills].sort();
if (new Set(declared).size !== declared.length) throw new Error("Duplicate skill declaration");
for (const skill of declared) {
  if (!(await stat(new URL(`skills/${skill}/SKILL.md`, root))).isFile()) throw new Error(`${skill} has no SKILL.md`);
}
const present = (await readdir(new URL("skills", root), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
if (JSON.stringify(present) !== JSON.stringify(declared)) throw new Error(`Skill manifest mismatch: declared ${declared.join(", ")}; found ${present.join(", ")}`);

console.log(`checked ${ids.size} Pi packages and ${declared.length} skills`);
