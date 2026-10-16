import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { patchFileWriteCopies } from "./patch-file-write.mjs";
import { probeFileTools } from "./file-write-probe.mjs";
import { inspectWrite } from "./file-write-guard.mjs";
import { adoptResidentLocalWrites, residentWriteProtocol, writeFunctionHash } from "./resident-write-adoption.mjs";

const originalModules = process.env.FILE_WRITE_NODE_MODULES;
if (!originalModules) throw new Error("FILE_WRITE_NODE_MODULES must explicitly name the frozen unpatched predecessor fixture");
if (readFileSync(join(originalModules, "@earendil-works/pi-coding-agent/dist/core/tools/write.js"), "utf8").startsWith("// PiStack file-write-guard-v1")) throw new Error("FILE_WRITE_NODE_MODULES must name the unpatched predecessor, not the selected new SDK; use file-write-probe.mjs for selected consumers");
function writableTree(path) {
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) writableTree(child);
    else if (entry.isFile()) chmodSync(child, 0o600);
  }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-write-patch-")), modules = join(root, "node_modules");
  mkdirSync(modules); mkdirSync(join(modules, "@earendil-works"));
  for (const entry of readdirSync(originalModules)) if (entry !== "@earendil-works") symlinkSync(join(originalModules, entry), join(modules, entry));
  for (const entry of readdirSync(join(originalModules, "@earendil-works"))) {
    const source = join(originalModules, "@earendil-works", entry), dest = join(modules, "@earendil-works", entry);
    if (!["pi-coding-agent", "pi-agent-core"].includes(entry)) symlinkSync(source, dest);
    else { mkdirSync(dest); cpSync(join(source, "dist"), join(dest, "dist"), { recursive: true }); cpSync(join(source, "package.json"), join(dest, "package.json")); writableTree(dest); if (existsSync(join(source, "node_modules"))) symlinkSync(join(source, "node_modules"), join(dest, "node_modules")); }
  }
  return { root, modules };
}

test("actual SDK, harness and bundled CLI write guard plus append", async () => {
  const f = fixture();
  try {
    patchFileWriteCopies(f.modules);
    patchFileWriteCopies(f.modules);
    assert.equal((await probeFileTools(f.modules)).passed, true);
    const coding = join(f.modules, "@earendil-works/pi-coding-agent/dist");
    const sdkTools = await import(pathToFileURL(join(coding, "core/tools/index.js")).href);
    let releaseInspection, enteredInspection;
    const started = new Promise(resolve => { enteredInspection = resolve; });
    const inspection = new Promise(resolve => { releaseInspection = resolve; });
    let inspections = 0; const effects = [];
    const queued = sdkTools.createWriteToolDefinition(f.root, { operations: {
      mkdir: async () => {}, fileSize: async () => { if (++inspections === 1) { enteredInspection(); await inspection; } return { ok: true, value: null }; },
      writeFile: async (_path, content) => { effects.push(content); }
    } });
    const controller = new AbortController();
    const first = assert.rejects(queued.execute("first", { path: "queued", content: "cancelled" }, controller.signal), /aborted/);
    await started;
    const second = queued.execute("second", { path: "queued", content: "accepted" });
    controller.abort(); await Promise.resolve();
    assert.equal(inspections, 1); assert.deepEqual(effects, []);
    releaseInspection(); await first; await second;
    assert.deepEqual(effects, ["accepted"]);
    const unsupported = sdkTools.createWriteToolDefinition(f.root, { operations: { mkdir: async () => {}, writeFile: async () => { throw new Error("must not enter mutation"); } } });
    await assert.rejects(unsupported.execute("unsupported", { path: "remote", content: "" }), { code: "WRITE_INSPECTION_UNSUPPORTED" });
    const chunk = readdirSync(join(coding, "bundle/chunks")).find(name => readFileSync(join(coding, "bundle/chunks", name), "utf8").includes("function createWriteToolDefinition(cwd,options)"));
    const bundled = await import(pathToFileURL(join(coding, "bundle/chunks", chunk)).href);
    const path = join(f.root, "bundle.txt"), original = Buffer.alloc(16000, 65);
    writeFileSync(path, original);
    await assert.rejects(bundled.createWriteToolDefinition(f.root).execute("b", { path, content: "" }), { code: "WRITE_DESTRUCTIVE_OVERWRITE_REFUSED" });
    assert.deepEqual(readFileSync(path), original);
    const append = bundled.createCodingTools(f.root).find(tool => tool.name === "append");
    assert(append);
    await append.execute("a", { path, content: "tail" });
    assert.deepEqual(readFileSync(path), Buffer.concat([original, Buffer.from("tail")]));
    const core = join(f.modules, "@earendil-works/pi-agent-core/dist");
    const harness = await import(pathToFileURL(join(core, "harness/tools/index.js")).href);
    const { NodeExecutionEnv } = await import(pathToFileURL(join(core, "harness/env/nodejs.js")).href);
    const env = new NodeExecutionEnv({ cwd: f.root });
    const context = { abortSignal: new AbortController().signal };
    await assert.rejects(harness.createWriteTool().execute("h", { path, content: "" }, undefined, { env }, undefined, context), { code: "WRITE_DESTRUCTIVE_OVERWRITE_REFUSED" });
    await harness.createAppendTool().execute("ha", { path, content: "more" }, undefined, { env }, undefined, context);
    assert.deepEqual(readFileSync(path), Buffer.concat([original, Buffer.from("tailmore")]));
    const records = ["<process-a>", "<process-b>", "<process-c>"];
    const code = `import {createAppendToolDefinition} from ${JSON.stringify(pathToFileURL(join(coding, "core/tools/append.js")).href)}; const tool=createAppendToolDefinition(${JSON.stringify(f.root)}); for(let i=0;i<20;i++) await tool.execute("cp",{path:process.argv[1],content:process.argv[2]});`;
    await Promise.all(records.map(record => new Promise((done, fail) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code, path, record], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = ""; child.stderr.on("data", data => { stderr += data; });
      child.on("error", fail); child.on("exit", status => status === 0 ? done() : fail(new Error(stderr)));
    })));
    const concurrent = readFileSync(path);
    const prefix = Buffer.concat([original, Buffer.from("tailmore")]);
    assert.deepEqual(concurrent.subarray(0, prefix.length), prefix);
    const suffix = concurrent.subarray(prefix.length).toString();
    assert.equal(suffix.length, records.reduce((bytes, record) => bytes + record.length * 20, 0));
    for (const record of records) assert.equal(suffix.split(record).length - 1, 20);
    const check = spawnSync(process.execPath, ["--check", join(coding, "bundle/chunks", chunk)], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("guard thresholds, unsupported inspection and malformed override are explicit", async () => {
  const observed = bytes => async () => ({ ok: true, value: bytes });
  assert.equal((await inspectWrite("x", "x".repeat(4096), undefined, observed(8192))).error.code, "WRITE_DESTRUCTIVE_OVERWRITE_REFUSED");
  assert.equal((await inspectWrite("x", "x".repeat(4097), undefined, observed(8192))).ok, true);
  assert.equal((await inspectWrite("x", "x", undefined, observed(4096))).ok, true);
  assert.equal((await inspectWrite("x", "", undefined, observed(1))).error.code, "WRITE_DESTRUCTIVE_OVERWRITE_REFUSED");
  assert.equal((await inspectWrite("x", "", undefined, observed(null))).ok, true);
  assert.equal((await inspectWrite("x", "", undefined, undefined)).error.code, "WRITE_INSPECTION_UNSUPPORTED");
  assert.equal((await inspectWrite("x", "", { expectedBytes: 1, reason: " " }, observed(1))).error.code, "WRITE_INVALID_OVERRIDE");
});

test("whole-cohort adoption guards captured old execute without recreating tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-resident-write-"));
  try {
    const { createWriteToolDefinition } = await import(pathToFileURL(join(originalModules, "@earendil-works/pi-coding-agent/dist/core/tools/write.js")).href);
    const operations = { writeFile: (path, content) => writeFile(path, content, "utf8"), mkdir: dir => mkdir(dir, { recursive: true }) };
    const old = createWriteToolDefinition(root, { operations });
    const previous = operations.writeFile;
    const blocked = { ...operations };
    const plan = { protocol: residentWriteProtocol, entries: [{ kind: "local-write", id: "synthetic-sdk", operations, expectedWriteSha256: writeFunctionHash(previous) }] };
    assert.equal(adoptResidentLocalWrites({ ...plan, entries: [...plan.entries, { kind: "local-write", id: "bad", operations: blocked, expectedWriteSha256: "0".repeat(64) }] }).ok, false);
    assert.equal(operations.writeFile, previous);
    assert.equal(adoptResidentLocalWrites(plan).ok, true);
    assert.equal(adoptResidentLocalWrites(plan).value.installed[0].alreadyInstalled, true);
    const path = join(root, "captured.txt"), original = Buffer.alloc(22000, 66);
    await writeFile(path, original);
    await assert.rejects(old.execute("synthetic-old", { path, content: "" }), { code: "WRITE_DESTRUCTIVE_OVERWRITE_REFUSED" });
    assert.deepEqual(await readFile(path), original);
    await assert.rejects(old.execute("synthetic-old", { path, content: "short" }), { code: "WRITE_DESTRUCTIVE_OVERWRITE_REFUSED" });
    assert.deepEqual(await readFile(path), original);
    const newer = createWriteToolDefinition(root, { operations });
    await assert.rejects(newer.execute("synthetic-new-sharing-ops", { path, content: "" }), { code: "WRITE_DESTRUCTIVE_OVERWRITE_REFUSED" });
    await old.execute("ordinary", { path, content: "X".repeat(original.length) });
    assert.equal((await readFile(path)).length, original.length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
