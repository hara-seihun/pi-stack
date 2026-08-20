#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const COMPARISON_IGNORED_SEGMENTS = new Set([
  ".cache",
  ".git",
  ".lake",
  ".nyc_output",
  ".pytest_cache",
  ".venv",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
]);
const MAX_CASES = 20;
const PI = process.env.PROMPT_EVAL_PI || "pi";
const EXACT_PROMPT_EXTENSION = fileURLToPath(new URL("./exact-system-prompt.ts", import.meta.url));
// Machine-wide usage custody lives in the pi-orchestrator ledger; isolated
// experiment sessions still load its usage logger so their spend is measured.
const USAGE_LOGGER_EXTENSION = path.join(os.homedir(), "projects", "pi-orchestrator", "src", "extension", "usage-logger.ts");

function usage() {
  return `prompt-eval — run isolated system-prompt experiments with Pi

Usage:
  prompt-eval init DIRECTORY
  prompt-eval run EXPERIMENT.json [OUTPUT_ROOT]
  prompt-eval compare RUN_DIRECTORY
  prompt-eval models [SEARCH]
  prompt-eval --help

The experiment file chooses the task, model, thinking level, system prompt,
timeout, and cases. "run" snapshots every input, gives each case an isolated
workspace, captures Pi's JSON event stream and final response, and writes a
pairwise comparison report.`;
}

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeName(value, label = "name") {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value)) {
    fail(`${label} must match [A-Za-z0-9][A-Za-z0-9._-]{0,79}`);
  }
  return value;
}

async function requireFile(file, label) {
  let info;
  try {
    info = await stat(file);
  } catch {
    fail(`${label} does not exist: ${file}`);
  }
  if (!info.isFile()) fail(`${label} is not a file: ${file}`);
  return file;
}

async function requireDirectory(directory, label) {
  let info;
  try {
    info = await stat(directory);
  } catch {
    fail(`${label} does not exist: ${directory}`);
  }
  if (!info.isDirectory()) fail(`${label} is not a directory: ${directory}`);
  return directory;
}

function resolveFrom(base, value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty path`);
  return path.resolve(base, value);
}

async function loadExperiment(configPath, outputOverride) {
  const absoluteConfig = path.resolve(configPath);
  await requireFile(absoluteConfig, "experiment file");
  let raw;
  try {
    raw = JSON.parse(await readFile(absoluteConfig, "utf8"));
  } catch (error) {
    fail(`cannot parse ${absoluteConfig}: ${error.message}`);
  }
  if (!isObject(raw)) fail("experiment must be a JSON object");
  const base = path.dirname(absoluteConfig);
  const name = safeName(raw.name, "experiment name");
  const task = await requireFile(resolveFrom(base, raw.task, "task"), "task");
  const workspace = raw.workspace === undefined
    ? undefined
    : await requireDirectory(resolveFrom(base, raw.workspace, "workspace"), "workspace");
  const defaultModel = raw.model;
  const defaultThinking = raw.thinking;
  const timeoutSeconds = raw.timeoutSeconds ?? 1800;
  const parallelism = raw.parallelism ?? 1;
  const tools = raw.tools ?? DEFAULT_TOOLS;
  const extensions = raw.extensions ?? true;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) {
    fail("timeoutSeconds must be an integer from 1 through 86400");
  }
  if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > MAX_CASES) {
    fail(`parallelism must be an integer from 1 through ${MAX_CASES}`);
  }
  if (!Array.isArray(tools) || tools.length === 0 || tools.some((tool) => typeof tool !== "string" || !tool)) {
    fail("tools must be a non-empty array of tool names");
  }
  if (typeof extensions !== "boolean") fail("extensions must be true or false");
  if (!Array.isArray(raw.cases) || raw.cases.length === 0 || raw.cases.length > MAX_CASES) {
    fail(`cases must contain 1 through ${MAX_CASES} entries`);
  }
  const seen = new Set();
  const cases = [];
  for (const [index, entry] of raw.cases.entries()) {
    if (!isObject(entry)) fail(`cases[${index}] must be an object`);
    const caseName = safeName(entry.name, `cases[${index}].name`);
    if (seen.has(caseName)) fail(`duplicate case name: ${caseName}`);
    seen.add(caseName);
    const model = entry.model ?? defaultModel;
    const thinking = entry.thinking ?? defaultThinking;
    if (typeof model !== "string" || !model.includes("/")) {
      fail(`case ${caseName} needs a model in provider/model form`);
    }
    if (!THINKING_LEVELS.has(thinking)) {
      fail(`case ${caseName} thinking must be one of ${[...THINKING_LEVELS].join(", ")}`);
    }
    const systemPrompt = await requireFile(
      resolveFrom(base, entry.systemPrompt, `case ${caseName} systemPrompt`),
      `case ${caseName} systemPrompt`,
    );
    cases.push({ name: caseName, model, thinking, systemPrompt });
  }
  const outputRoot = outputOverride
    ? path.resolve(outputOverride)
    : path.resolve(base, typeof raw.outputRoot === "string" ? raw.outputRoot : "results");
  return {
    configPath: absoluteConfig,
    name,
    task,
    workspace,
    timeoutSeconds,
    parallelism: Math.min(parallelism, cases.length),
    tools: [...new Set(tools)],
    extensions,
    outputRoot,
    cases,
  };
}

function timestampName() {
  return new Date().toISOString().replace(/[-:]/gu, "").replace("T", "-").replace("Z", "Z");
}

async function uniqueRunDirectory(outputRoot, name) {
  await mkdir(outputRoot, { recursive: true });
  const stem = `${name}-${timestampName()}`;
  for (let index = 0; index < 1000; index += 1) {
    const candidate = path.join(outputRoot, index === 0 ? stem : `${stem}-${index}`);
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  fail(`cannot allocate a run directory under ${outputRoot}`);
}

async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function inventory(root) {
  const entries = {};
  async function walk(directory, relative) {
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      const absolute = path.join(directory, child.name);
      const info = await lstat(absolute);
      if (info.isDirectory()) {
        await walk(absolute, childRelative);
      } else if (info.isFile()) {
        entries[childRelative] = { type: "file", size: info.size, sha256: await sha256File(absolute) };
      } else if (info.isSymbolicLink()) {
        entries[childRelative] = { type: "symlink", target: await readlink(absolute) };
      } else {
        entries[childRelative] = { type: "other", size: info.size };
      }
    }
  }
  await walk(root, "");
  return entries;
}

function entryEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changesFrom(before, after) {
  const created = [];
  const modified = [];
  const deleted = [];
  for (const name of Object.keys(after).sort()) {
    if (!(name in before)) created.push(name);
    else if (!entryEqual(before[name], after[name])) modified.push(name);
  }
  for (const name of Object.keys(before).sort()) {
    if (!(name in after)) deleted.push(name);
  }
  return { created, modified, deleted };
}

function assistantText(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function addUsage(total, usage) {
  if (!isObject(usage)) return;
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number" && Number.isFinite(value)) total[key] = (total[key] ?? 0) + value;
  }
}

function terminateGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function runCase({ experiment, runDirectory, caseConfig, seedInventory, manifest, writeManifest }) {
  const caseDirectory = path.join(runDirectory, "cases", caseConfig.name);
  const workspace = path.join(caseDirectory, "workspace");
  await mkdir(caseDirectory, { recursive: true });
  if (experiment.workspace) await cp(path.join(runDirectory, "inputs", "workspace"), workspace, { recursive: true });
  else await mkdir(workspace, { recursive: true });
  const taskText = await readFile(path.join(runDirectory, "inputs", "task.md"), "utf8");
  const promptSnapshot = path.join(runDirectory, "inputs", "prompts", `${caseConfig.name}.md`);
  const eventPath = path.join(caseDirectory, "events.jsonl");
  const stderrPath = path.join(caseDirectory, "stderr.log");
  const eventStream = createWriteStream(eventPath, { flags: "wx" });
  const stderrStream = createWriteStream(stderrPath, { flags: "wx" });
  const args = [
    "--mode", "json",
    "--no-session",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-approve",
    "--extension", EXACT_PROMPT_EXTENSION,
  ];
  if (!experiment.extensions) args.push("--no-extensions", "--extension", USAGE_LOGGER_EXTENSION);
  args.push(
    "--model", caseConfig.model,
    "--thinking", caseConfig.thinking,
    "--tools", experiment.tools.join(","),
  );
  const startedAt = new Date();
  const manifestCase = manifest.cases.find((entry) => entry.name === caseConfig.name);
  Object.assign(manifestCase, { status: "running", startedAt: startedAt.toISOString() });
  await writeManifest();
  process.stderr.write(`[prompt-eval] starting ${caseConfig.name} (${caseConfig.model}, ${caseConfig.thinking})\n`);
  const child = spawn(PI, args, {
    cwd: workspace,
    detached: true,
    env: {
      ...process.env,
      PROMPT_EVAL_SYSTEM_PROMPT: promptSnapshot,
      PI_USAGE_OWNER_KIND: "prompt-eval",
      PI_USAGE_OWNER_ID: `${experiment.name}/${caseConfig.name}/${manifest.runId ?? path.basename(runDirectory)}`,
      PI_USAGE_OWNER_LABEL: `${experiment.name}/${caseConfig.name}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let timedOut = false;
  let spawnError;
  let stdoutRemainder = "";
  let lastAssistant;
  const usage = {};
  child.stdout.on("data", (chunk) => {
    eventStream.write(chunk);
    stdoutRemainder += chunk.toString("utf8");
    const lines = stdoutRemainder.split("\n");
    stdoutRemainder = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "message_end" && event.message?.role === "assistant") {
          lastAssistant = event.message;
          addUsage(usage, event.message.usage);
        }
      } catch {
        // The raw stream remains authoritative even if a provider emits a non-JSON diagnostic.
      }
    }
  });
  child.stderr.pipe(stderrStream);
  child.on("error", (error) => { spawnError = error; });
  child.stdin.end(taskText);
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateGroup(child, "SIGTERM");
    setTimeout(() => terminateGroup(child, "SIGKILL"), 5000).unref();
  }, experiment.timeoutSeconds * 1000);
  timeout.unref();
  const { code, signal } = await new Promise((resolve) => {
    child.on("close", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  clearTimeout(timeout);
  await Promise.all([
    new Promise((resolve) => eventStream.end(resolve)),
    new Promise((resolve) => stderrStream.end(resolve)),
  ]);
  if (stdoutRemainder.trim()) {
    try {
      const event = JSON.parse(stdoutRemainder);
      if (event.type === "message_end" && event.message?.role === "assistant") {
        lastAssistant = event.message;
        addUsage(usage, event.message.usage);
      }
    } catch {
      // Already retained in events.jsonl.
    }
  }
  await mkdir(workspace, { recursive: true });
  const finalText = assistantText(lastAssistant);
  await writeFile(path.join(caseDirectory, "final.md"), finalText ? `${finalText}\n` : "");
  const finalInventory = await inventory(workspace);
  const changes = changesFrom(seedInventory, finalInventory);
  const endedAt = new Date();
  const assistantError = lastAssistant?.stopReason === "error" || Boolean(lastAssistant?.errorMessage);
  const status = timedOut ? "timed-out" : (spawnError || code !== 0 || assistantError ? "failed" : "completed");
  const result = {
    schemaVersion: 1,
    name: caseConfig.name,
    model: caseConfig.model,
    thinking: caseConfig.thinking,
    status,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationSeconds: Number(((endedAt - startedAt) / 1000).toFixed(3)),
    timeoutSeconds: experiment.timeoutSeconds,
    exitCode: code,
    signal,
    spawnError: spawnError?.message,
    assistantStopReason: lastAssistant?.stopReason,
    assistantError: lastAssistant?.errorMessage,
    usage,
    changes,
    inventory: finalInventory,
  };
  await atomicJson(path.join(caseDirectory, "result.json"), result);
  Object.assign(manifestCase, {
    status,
    endedAt: result.endedAt,
    durationSeconds: result.durationSeconds,
    result: `cases/${caseConfig.name}/result.json`,
  });
  await writeManifest();
  process.stderr.write(`[prompt-eval] ${caseConfig.name}: ${status} (${result.durationSeconds}s)\n`);
  return result;
}

async function commandOutput(command, args, cwd, outputPath) {
  const output = createWriteStream(outputPath);
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
  child.stdout.pipe(output);
  const result = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  await finished(output);
  return result;
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}

function comparisonIgnored(relativePath) {
  const segments = relativePath.split("/");
  return segments.some((segment) => COMPARISON_IGNORED_SEGMENTS.has(segment)) || relativePath.endsWith(".pyc");
}

function comparisonInventory(fullInventory) {
  return Object.fromEntries(Object.entries(fullInventory).filter(([name]) => !comparisonIgnored(name)));
}

function comparisonChanges(changes) {
  const visible = {
    created: changes.created.filter((name) => !comparisonIgnored(name)),
    modified: changes.modified.filter((name) => !comparisonIgnored(name)),
    deleted: changes.deleted.filter((name) => !comparisonIgnored(name)),
  };
  const omitted = changes.created.length + changes.modified.length + changes.deleted.length
    - visible.created.length - visible.modified.length - visible.deleted.length;
  return { ...visible, omitted };
}

async function materializeComparisonTree(source, target, fileInventory) {
  for (const [relative, entry] of Object.entries(fileInventory)) {
    const destination = path.join(target, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    if (entry.type === "file") await link(path.join(source, relative), destination);
    else if (entry.type === "symlink") await symlink(entry.target, destination);
  }
}

function artifactDifference(left, right) {
  const onlyLeft = [];
  const onlyRight = [];
  const different = [];
  for (const name of Object.keys(left).sort()) {
    if (!(name in right)) onlyLeft.push(name);
    else if (!entryEqual(left[name], right[name])) different.push(name);
  }
  for (const name of Object.keys(right).sort()) if (!(name in left)) onlyRight.push(name);
  return { onlyLeft, onlyRight, different };
}

function listOrNone(values) {
  if (!values.length) return "none";
  const shown = values.slice(0, 40).map((value) => `\`${value}\``).join(", ");
  return values.length <= 40 ? shown : `${shown}, … **${values.length - 40} more** (complete list in result metadata)`;
}

async function generateComparison(runDirectory) {
  const manifestPath = path.join(runDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const available = [];
  for (const caseEntry of manifest.cases) {
    const resultPath = path.join(runDirectory, "cases", caseEntry.name, "result.json");
    try {
      const result = JSON.parse(await readFile(resultPath, "utf8"));
      const final = await readFile(path.join(runDirectory, "cases", caseEntry.name, "final.md"), "utf8");
      available.push({ ...caseEntry, result, final });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const comparisonDirectory = path.join(runDirectory, "comparisons");
  await rm(comparisonDirectory, { recursive: true, force: true });
  await mkdir(comparisonDirectory, { recursive: true });
  const filteredRoot = await mkdtemp(path.join(runDirectory, ".comparison-"));
  const filteredInventories = new Map();
  const pairs = [];
  try {
    for (const entry of available) {
      const filtered = comparisonInventory(entry.result.inventory);
      filteredInventories.set(entry.name, filtered);
      await materializeComparisonTree(
        path.join(runDirectory, "cases", entry.name, "workspace"),
        path.join(filteredRoot, "cases", entry.name, "workspace"),
        filtered,
      );
    }
    for (let leftIndex = 0; leftIndex < available.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < available.length; rightIndex += 1) {
        const left = available[leftIndex];
        const right = available[rightIndex];
        const pairName = `${left.name}--${right.name}`;
        const workspacePatch = path.join(comparisonDirectory, `${pairName}-workspace.patch`);
        const finalPatch = path.join(comparisonDirectory, `${pairName}-final.patch`);
        const workspaceDiff = await commandOutput("git", [
          "diff", "--no-index", "--no-ext-diff", "--no-renames", "--",
          `cases/${left.name}/workspace`, `cases/${right.name}/workspace`,
        ], filteredRoot, workspacePatch);
        if (![0, 1].includes(workspaceDiff.code)) fail(`git workspace diff failed for ${pairName}`);
        const finalDiff = await commandOutput("git", [
          "diff", "--no-index", "--no-ext-diff", "--no-renames", "--",
          `cases/${left.name}/final.md`, `cases/${right.name}/final.md`,
        ], runDirectory, finalPatch);
        if (![0, 1].includes(finalDiff.code)) fail(`git final diff failed for ${pairName}`);
        pairs.push({
          left,
          right,
          pairName,
          difference: artifactDifference(filteredInventories.get(left.name), filteredInventories.get(right.name)),
        });
      }
    }
  } finally {
    await rm(filteredRoot, { recursive: true, force: true });
  }
  const lines = [
    `# ${manifest.name} comparison`,
    "",
    `- Run: \`${path.basename(runDirectory)}\``,
    `- Task snapshot: [inputs/task.md](inputs/task.md)`,
    `- Status: **${manifest.status}**`,
    "",
    "## Results",
    "",
    "Generated dependency, cache, and build directories are retained in each workspace and complete inventory, but omitted from this report and workspace patches.",
    "",
    "| Case | Model | Thinking | Status | Duration | Created | Modified | Deleted | Omitted generated |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const entry of available) {
    const changes = comparisonChanges(entry.result.changes);
    lines.push(`| [${markdownCell(entry.name)}](cases/${entry.name}/) | ${markdownCell(entry.model)} | ${markdownCell(entry.thinking)} | ${markdownCell(entry.result.status)} | ${entry.result.durationSeconds}s | ${changes.created.length} | ${changes.modified.length} | ${changes.deleted.length} | ${changes.omitted} |`);
  }
  for (const entry of available) {
    const changes = comparisonChanges(entry.result.changes);
    lines.push(
      "",
      `## ${entry.name}`,
      "",
      `System prompt: [inputs/prompts/${entry.name}.md](inputs/prompts/${entry.name}.md)  `,
      `Events: [cases/${entry.name}/events.jsonl](cases/${entry.name}/events.jsonl)  `,
      `Metadata: [cases/${entry.name}/result.json](cases/${entry.name}/result.json)  `,
      `Workspace: [cases/${entry.name}/workspace/](cases/${entry.name}/workspace/)`,
      "",
      `Created: ${listOrNone(changes.created)}`,
      "",
      `Modified: ${listOrNone(changes.modified)}`,
      "",
      `Deleted: ${listOrNone(changes.deleted)}`,
      "",
      `Generated paths omitted here: ${changes.omitted} (retained in workspace and result metadata)`,
      "",
      "### Final response",
      "",
      entry.final.trim() || "_(No assistant text response.)_",
    );
  }
  if (pairs.length) lines.push("", "# Pairwise differences");
  for (const pair of pairs) {
    lines.push(
      "",
      `## ${pair.left.name} vs ${pair.right.name}`,
      "",
      `- Final-response diff: [${pair.pairName}-final.patch](comparisons/${pair.pairName}-final.patch)`,
      `- Workspace diff (generated paths omitted): [${pair.pairName}-workspace.patch](comparisons/${pair.pairName}-workspace.patch)`,
      `- Only ${pair.left.name}: ${listOrNone(pair.difference.onlyLeft)}`,
      `- Only ${pair.right.name}: ${listOrNone(pair.difference.onlyRight)}`,
      `- Different in both: ${listOrNone(pair.difference.different)}`,
    );
  }
  await writeFile(path.join(runDirectory, "comparison.md"), `${lines.join("\n")}\n`);
  return available;
}

async function runExperiment(configPath, outputOverride) {
  const experiment = await loadExperiment(configPath, outputOverride);
  const version = spawnSync(PI, ["--version"], { encoding: "utf8" });
  if (version.error || version.status !== 0) fail(`cannot execute ${PI}: ${version.error?.message || version.stderr?.trim()}`);
  const runDirectory = await uniqueRunDirectory(experiment.outputRoot, experiment.name);
  await mkdir(path.join(runDirectory, "inputs", "prompts"), { recursive: true });
  await mkdir(path.join(runDirectory, "cases"), { recursive: true });
  await cp(experiment.task, path.join(runDirectory, "inputs", "task.md"));
  const seedDirectory = path.join(runDirectory, "inputs", "workspace");
  if (experiment.workspace) await cp(experiment.workspace, seedDirectory, { recursive: true });
  else await mkdir(seedDirectory);
  for (const caseConfig of experiment.cases) {
    await cp(caseConfig.systemPrompt, path.join(runDirectory, "inputs", "prompts", `${caseConfig.name}.md`));
  }
  const seedInventory = await inventory(seedDirectory);
  const manifestCases = [];
  for (const entry of experiment.cases) {
    manifestCases.push({
      name: entry.name,
      model: entry.model,
      thinking: entry.thinking,
      systemPromptSource: entry.systemPrompt,
      systemPromptSha256: await sha256File(path.join(runDirectory, "inputs", "prompts", `${entry.name}.md`)),
      status: "pending",
    });
  }
  const startedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    name: experiment.name,
    status: "running",
    startedAt,
    piVersion: version.stdout.trim(),
    configSource: experiment.configPath,
    taskSource: experiment.task,
    taskSha256: await sha256File(path.join(runDirectory, "inputs", "task.md")),
    workspaceSource: experiment.workspace,
    timeoutSeconds: experiment.timeoutSeconds,
    parallelism: experiment.parallelism,
    tools: experiment.tools,
    extensions: experiment.extensions,
    seedInventory,
    cases: manifestCases,
  };
  const manifestPath = path.join(runDirectory, "manifest.json");
  let manifestWrites = Promise.resolve();
  const writeManifest = () => {
    const snapshot = structuredClone(manifest);
    manifestWrites = manifestWrites.then(() => atomicJson(manifestPath, snapshot));
    return manifestWrites;
  };
  await writeManifest();
  let next = 0;
  const results = [];
  const workers = Array.from({ length: experiment.parallelism }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= experiment.cases.length) return;
      const caseConfig = experiment.cases[index];
      try {
        results[index] = await runCase({ experiment, runDirectory, caseConfig, seedInventory, manifest, writeManifest });
      } catch (error) {
        const entry = manifest.cases[index];
        Object.assign(entry, { status: "failed", error: error.message, endedAt: new Date().toISOString() });
        await writeManifest();
        results[index] = { status: "failed", error: error.message };
        process.stderr.write(`[prompt-eval] ${caseConfig.name}: failed (${error.message})\n`);
      }
    }
  });
  await Promise.all(workers);
  manifest.endedAt = new Date().toISOString();
  manifest.status = results.every((result) => result?.status === "completed") ? "completed" : "completed-with-failures";
  await writeManifest();
  await generateComparison(runDirectory);
  process.stdout.write(`${runDirectory}\n`);
  if (manifest.status !== "completed") process.exitCode = 1;
}

async function initExperiment(directoryArgument) {
  const directory = path.resolve(directoryArgument);
  await mkdir(path.join(directory, "prompts"), { recursive: true });
  const files = {
    "experiment.json": `${JSON.stringify({
      name: "prompt-comparison",
      task: "task.md",
      model: "openai-codex/gpt-5.6-sol",
      thinking: "high",
      timeoutSeconds: 900,
      parallelism: 1,
      cases: [
        { name: "baseline", systemPrompt: "prompts/baseline.md" },
        { name: "structured", systemPrompt: "prompts/structured.md" },
      ],
    }, null, 2)}\n`,
    "task.md": "Solve the task described here. Put any durable deliverables in the current working directory.\n",
    "prompts/baseline.md": "You are a capable agent. Complete the user's task.\n",
    "prompts/structured.md": "You are a capable agent. Inspect the task carefully, validate your work, and report the result concisely.\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    const destination = path.join(directory, relative);
    try {
      await stat(destination);
      fail(`refusing to overwrite ${destination}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await writeFile(destination, content, { flag: "wx" });
  }
  process.stdout.write(`${path.join(directory, "experiment.json")}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const command = args.shift();
  if (command === "init") {
    if (args.length !== 1) fail("init requires exactly one directory");
    await initExperiment(args[0]);
  } else if (command === "run") {
    if (args.length < 1 || args.length > 2) fail("run requires EXPERIMENT.json and an optional OUTPUT_ROOT");
    await runExperiment(args[0], args[1]);
  } else if (command === "compare") {
    if (args.length !== 1) fail("compare requires exactly one run directory");
    const runDirectory = await requireDirectory(path.resolve(args[0]), "run directory");
    await generateComparison(runDirectory);
    process.stdout.write(`${path.join(runDirectory, "comparison.md")}\n`);
  } else if (command === "models") {
    if (args.length > 1) fail("models accepts at most one search string");
    const result = spawnSync(PI, args.length ? ["--list-models", args[0]] : ["--list-models"], { stdio: "inherit" });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } else {
    fail(`unknown command: ${command}`);
  }
}

main().catch((error) => {
  process.stderr.write(`prompt-eval: ${error.message}\n`);
  process.exitCode = 1;
});
