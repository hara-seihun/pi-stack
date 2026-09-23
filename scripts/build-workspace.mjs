import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const name = process.argv[2];
const builds = {
  orchestrator: { sources: ["packages/orchestrator"], output: "packages/orchestrator/dist" },
  remote: { sources: ["apps/remote", "packages/orchestrator/src"], output: "apps/remote/web/dist" },
};
const build = builds[name];
if (!build) {
  console.error("usage: node scripts/build-workspace.mjs orchestrator|remote");
  process.exit(64);
}

function digestFiles(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    const path = join(root, file);
    hash.update(file).update("\0");
    if (!existsSync(path)) { hash.update("missing\0"); continue; }
    const stat = lstatSync(path);
    hash.update(`${stat.mode}\0`);
    hash.update(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function outputDigest() {
  const files = [];
  function visit(directory) {
    if (!existsSync(join(root, directory))) return;
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(path);
    }
  }
  visit(build.output);
  return files.length ? digestFiles(files.sort()) : null;
}

const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...build.sources], { cwd: root, encoding: "utf8" });
if (listed.status !== 0) {
  console.error(listed.error?.message ?? listed.stderr);
  process.exit(1);
}
const sources = listed.stdout.split("\0").filter(file => file && !file.startsWith(`${build.output}/`));
const inputFiles = [...new Set([
  ...sources, "package.json", "package-lock.json", "node_modules/.package-lock.json", "scripts/build-workspace.mjs",
])].sort();
const inputs = digestFiles(inputFiles);
const receiptPath = join(root, "node_modules", `.pi-stack-build-${name}.json`);
const receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : null;
if (receipt?.inputs === inputs && receipt.node === process.version && receipt.output === outputDigest()) {
  console.log(`reused Pi ${name} build ${inputs.slice(0, 12)}`);
  process.exit(0);
}

rmSync(receiptPath, { force: true });
rmSync(join(root, build.output), { recursive: true, force: true });
const result = spawnSync("npm", ["run", "build", `--workspace=pi-${name}`], { cwd: root, stdio: "inherit" });
if (result.status !== 0) {
  console.error(`Pi ${name} build failed: ${result.error?.message ?? result.signal ?? result.status}`);
  process.exit(result.status || 1);
}
const output = outputDigest();
if (!output || digestFiles(inputFiles) !== inputs) {
  console.error(`Pi ${name} build produced no files or its inputs changed during the build`);
  process.exit(1);
}
mkdirSync(dirname(receiptPath), { recursive: true });
const temporary = `${receiptPath}.${process.pid}.tmp`;
writeFileSync(temporary, JSON.stringify({ inputs, output, node: process.version }) + "\n");
renameSync(temporary, receiptPath);
