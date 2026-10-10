import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const name = process.argv[2];
const builds = {
  orchestrator: { workspace: "pi-orchestrator", sources: ["packages/orchestrator", "packages/kenan-memory", "packages/kenan-root", "scripts/workspace-closure.mjs"], output: "packages/orchestrator/dist", extraOutputs: ["packages/kenan-memory/dist", "packages/kenan-root/dist"], requiredArtifacts: ["packages/orchestrator/dist/core/main.js", "packages/orchestrator/dist/core/config.js"] },
  remote: { workspace: "pi-remote", sources: ["apps/remote", "packages/orchestrator/src", "packages/kenan-memory", "packages/kenan-root"], output: "apps/remote/web/dist", extraOutputs: ["apps/remote/server/phone/dist"] },
  "kenan-root": { workspace: "pi-orchestrator", sources: ["packages/kenan-root", "packages/kenan-memory", "packages/orchestrator", "scripts/workspace-closure.mjs"], output: "packages/kenan-root/dist", extraOutputs: ["packages/orchestrator/dist", "packages/kenan-memory/dist"] },
};
const build = builds[name];
if (!build) {
  console.error("usage: node scripts/build-workspace.mjs orchestrator|remote|kenan-root");
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
  if (build.requiredArtifacts?.some(path => !existsSync(join(root, path)))) return null;
  const files = [];
  function visit(directory) {
    if (!existsSync(join(root, directory))) return;
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(path);
    }
  }
  for (const output of [build.output, ...(build.extraOutputs ?? [])]) {
    const before = files.length;
    visit(output);
    if (files.length === before) return null;
  }
  return digestFiles(files.sort());
}

const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...build.sources], { cwd: root, encoding: "utf8" });
if (listed.status !== 0) {
  console.error(listed.error?.message ?? listed.stderr);
  process.exit(1);
}
const outputs = [build.output, ...(build.extraOutputs ?? [])];
const sources = listed.stdout.split("\0").filter(file => file && !outputs.some(output => file.startsWith(`${output}/`)));
const inputFiles = [...new Set([
  ...sources, "package.json", "package-lock.json", "node_modules/.package-lock.json", "scripts/build-workspace.mjs",
])].sort();
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
if (revision.status !== 0) throw new Error('Cannot identify build source');
const sourceIdentity = revision.stdout.trim();
const inputs = digestFiles(inputFiles);
function bindRevision() {
  if (name !== 'remote') return;
  for (const name of ['release-revision.js']) {
    const path = join(root, build.output, name);
    if (!existsSync(path)) continue;
    const html = readFileSync(path, 'utf8');
    const next = html.replace(/globalThis\.__PI_STACK_RELEASE_REVISION__="[a-f0-9]{40}"/g, `globalThis.__PI_STACK_RELEASE_REVISION__="${sourceIdentity}"`);
    if (next !== html) {
      writeFileSync(path, next);
      for (const suffix of ['.gz', '.br']) rmSync(path + suffix, { force: true });
    }
  }
}
function writeReceipt(output) {
  mkdirSync(dirname(receiptPath), { recursive: true });
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ inputs, output, node: process.version, revision: sourceIdentity }) + "\n");
  renameSync(temporary, receiptPath);
}
const receiptPath = join(root, "node_modules", `.pi-stack-build-${name}.json`);
const receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : null;
if (receipt?.inputs === inputs && receipt.node === process.version && receipt.output === outputDigest()) {
  bindRevision();
  if (receipt.revision !== sourceIdentity) writeReceipt(outputDigest());
  console.log(`reused Pi ${name} build ${inputs.slice(0, 12)}`);
  process.exit(0);
}

rmSync(receiptPath, { force: true });
for (const output of [build.output, ...(build.extraOutputs ?? [])]) rmSync(join(root, output), { recursive: true, force: true });
const result = spawnSync("npm", ["run", "build", `--workspace=${build.workspace}`], { cwd: root, stdio: "inherit" });
if (result.status !== 0) {
  console.error(`Pi ${name} build failed: ${result.error?.message ?? result.signal ?? result.status}`);
  process.exit(result.status || 1);
}
bindRevision();
const output = outputDigest();
if (!output || digestFiles(inputFiles) !== inputs) {
  console.error(`Pi ${name} build produced no files or its inputs changed during the build`);
  process.exit(1);
}
writeReceipt(output);
