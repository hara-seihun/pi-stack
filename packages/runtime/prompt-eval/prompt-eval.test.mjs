import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cli = new URL("./prompt-eval.mjs", import.meta.url).pathname;

async function fakePi(root) {
  const file = path.join(root, "fake-pi.mjs");
  await writeFile(file, `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("pi-test-1"); process.exit(0); }
if (args[0] === "--list-models") { console.log("provider model"); process.exit(0); }
let task = "";
for await (const chunk of process.stdin) task += chunk;
if (!args.includes("--extension") || args.includes("--system-prompt")) process.exit(4);
const system = await readFile(process.env.PROMPT_EVAL_SYSTEM_PROMPT, "utf8");
if (system.includes("SLOW")) await new Promise((resolve) => setTimeout(resolve, 5000));
const label = system.includes("SECOND") ? "second" : "first";
await writeFile("artifact.txt", label + ":" + task.trim() + "\\n");
console.log(JSON.stringify({type:"session",version:3,id:"test",cwd:process.cwd()}));
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"final-" + label}],stopReason:"stop",usage:{input:2,output:1}}}));
`);
  await chmod(file, 0o755);
  return file;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-eval-test-"));
  const fake = await fakePi(root);
  await mkdir(path.join(root, "prompts"));
  await writeFile(path.join(root, "task.md"), "make a thing\n");
  await writeFile(path.join(root, "prompts", "first.md"), "FIRST\n");
  await writeFile(path.join(root, "prompts", "second.md"), "SECOND\n");
  await writeFile(path.join(root, "experiment.json"), JSON.stringify({
    name: "test-comparison",
    task: "task.md",
    model: "test/model",
    thinking: "high",
    timeoutSeconds: 10,
    parallelism: 2,
    extensions: false,
    cases: [
      { name: "first", systemPrompt: "prompts/first.md" },
      { name: "second", systemPrompt: "prompts/second.md" },
    ],
  }));
  return { root, fake };
}

test("run captures isolated artifacts, transcripts, metadata, and comparisons", async () => {
  const { root, fake } = await fixture();
  const outputRoot = path.join(root, "output");
  const result = await execFileAsync(process.execPath, [cli, "run", path.join(root, "experiment.json"), outputRoot], {
    env: { ...process.env, PROMPT_EVAL_PI: fake },
  });
  const runDirectory = result.stdout.trim();
  assert.equal(path.dirname(runDirectory), outputRoot);
  assert.equal(await readFile(path.join(runDirectory, "cases", "first", "artifact.txt")).catch(() => "missing"), "missing");
  assert.equal(await readFile(path.join(runDirectory, "cases", "first", "workspace", "artifact.txt"), "utf8"), "first:make a thing\n");
  assert.equal(await readFile(path.join(runDirectory, "cases", "second", "workspace", "artifact.txt"), "utf8"), "second:make a thing\n");
  assert.equal(await readFile(path.join(runDirectory, "cases", "first", "final.md"), "utf8"), "final-first\n");
  const manifest = JSON.parse(await readFile(path.join(runDirectory, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "completed");
  assert.deepEqual(manifest.cases.map((entry) => entry.status), ["completed", "completed"]);
  const first = JSON.parse(await readFile(path.join(runDirectory, "cases", "first", "result.json"), "utf8"));
  assert.deepEqual(first.changes, { created: ["artifact.txt"], modified: [], deleted: [] });
  assert.equal(first.usage.input, 2);
  const report = await readFile(path.join(runDirectory, "comparison.md"), "utf8");
  assert.match(report, /first vs second/u);
  assert.match(report, /final-first/u);
  assert.match(report, /final-second/u);
  const patch = await readFile(path.join(runDirectory, "comparisons", "first--second-workspace.patch"), "utf8");
  assert.match(patch, /-first:make a thing/u);
  assert.match(patch, /\+second:make a thing/u);
  assert.ok((await readdir(path.join(runDirectory, "cases", "first"))).includes("events.jsonl"));
});

test("compare regenerates a deleted report from retained run custody", async () => {
  const { root, fake } = await fixture();
  const outputRoot = path.join(root, "output");
  const run = await execFileAsync(process.execPath, [cli, "run", path.join(root, "experiment.json"), outputRoot], {
    env: { ...process.env, PROMPT_EVAL_PI: fake },
  });
  const runDirectory = run.stdout.trim();
  await writeFile(path.join(runDirectory, "comparison.md"), "stale\n");
  const compared = await execFileAsync(process.execPath, [cli, "compare", runDirectory], {
    env: { ...process.env, PROMPT_EVAL_PI: fake },
  });
  assert.equal(compared.stdout.trim(), path.join(runDirectory, "comparison.md"));
  assert.match(await readFile(path.join(runDirectory, "comparison.md"), "utf8"), /# test-comparison comparison/u);
});

test("timeout terminates a case and preserves its result custody", async () => {
  const { root, fake } = await fixture();
  await writeFile(path.join(root, "prompts", "first.md"), "SLOW\n");
  await writeFile(path.join(root, "experiment.json"), JSON.stringify({
    name: "timeout-test",
    task: "task.md",
    model: "test/model",
    thinking: "minimal",
    timeoutSeconds: 1,
    cases: [{ name: "slow", systemPrompt: "prompts/first.md" }],
  }));
  const outputRoot = path.join(root, "output");
  await assert.rejects(execFileAsync(process.execPath, [cli, "run", path.join(root, "experiment.json"), outputRoot], {
    env: { ...process.env, PROMPT_EVAL_PI: fake },
  }));
  const [runName] = await readdir(outputRoot);
  const runDirectory = path.join(outputRoot, runName);
  const manifest = JSON.parse(await readFile(path.join(runDirectory, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "completed-with-failures");
  assert.equal(manifest.cases[0].status, "timed-out");
  const result = JSON.parse(await readFile(path.join(runDirectory, "cases", "slow", "result.json"), "utf8"));
  assert.equal(result.status, "timed-out");
  assert.equal(result.signal, "SIGTERM");
  assert.match(await readFile(path.join(runDirectory, "comparison.md"), "utf8"), /timed-out/u);
});

test("init writes a runnable experiment skeleton and refuses overwrites", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-eval-init-"));
  const directory = path.join(root, "experiment");
  const created = await execFileAsync(process.execPath, [cli, "init", directory]);
  assert.equal(created.stdout.trim(), path.join(directory, "experiment.json"));
  const config = JSON.parse(await readFile(path.join(directory, "experiment.json"), "utf8"));
  assert.equal(config.cases.length, 2);
  await assert.rejects(execFileAsync(process.execPath, [cli, "init", directory]));
});
