import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { patchBashSpillCopies } from "./patch-bash-spill.mjs";

const runtime = process.env.PI_TEST_RUNTIME_ENTRY ?? import.meta.resolve("@earendil-works/pi-coding-agent");
const installedProof = Boolean(process.env.PI_TEST_RUNTIME_ENTRY);
const originalBase = dirname(fileURLToPath(runtime));
const directory = mkdtempSync(join(tmpdir(), "pi-shell-memory-test-"));
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
const modules = join(directory, "modules");
const base = join(modules, "@earendil-works/pi-coding-agent/dist");
mkdirSync(dirname(base), { recursive: true });
cpSync(dirname(originalBase), dirname(base), { recursive: true });
cpSync(join(dirname(dirname(originalBase)), "pi-agent-core"), join(modules, "@earendil-works/pi-agent-core"), { recursive: true });
symlinkSync(dirname(dirname(dirname(originalBase))), join(directory, "node_modules"));
if (!installedProof) patchBashSpillCopies(modules);
const chunks = join(base, "bundle/chunks");
const bundlePath = readdirSync(chunks).map(name => join(chunks, name)).find(path => path.endsWith(".js") && readFileSync(path, "utf8").includes("async function executeBashWithOperations("));
assert.ok(bundlePath, "bundled shell executor exists");
const patchedBundle = readFileSync(bundlePath, "utf8");
if (!installedProof) {
  patchBashSpillCopies(modules);
  assert.equal(readFileSync(bundlePath, "utf8"), patchedBundle, "patch is idempotent");
}
// Export private entrypoints for the proof without replacing their implementation.
appendFileSync(bundlePath, "\nexport { executeBashWithOperations, OutputAccumulator, bashExecutionToText, createBashTool as createHarnessBashTool, executeShellWithCapture };\n");
const load = path => import(pathToFileURL(path).href);
const sdk = {
  ...await load(join(base, "core/tools/bash.js")),
  ...await load(join(base, "modes/interactive/theme/theme.js")),
  ...await load(join(base, "core/bash-executor.js")),
  ...await load(join(base, "core/messages.js")),
  ...await load(join(base, "core/tools/output-accumulator.js")),
  ...await load(join(base, "modes/interactive/components/bash-execution.js")),
};
const bundle = await load(bundlePath);
sdk.initTheme("dark");
bundle.initTheme("dark");
const { truncateTail } = await load(join(base, "core/tools/truncate.js"));
const harnessBase = join(modules, "@earendil-works/pi-agent-core/dist/harness");
const harnessSdk = {
  createHarnessBashTool: (await load(join(harnessBase, "tools/bash.js"))).createBashTool,
  ...await load(join(harnessBase, "utils/shell-output.js")),
};
const { NodeExecutionEnv } = await load(join(harnessBase, "env/nodejs.js"));
const spillFiles = () => readdirSync(tmpdir()).filter(name => /^pi-(?:bash|output)-.*\.log$/.test(name)).sort();
const startFiles = spillFiles();
const bytes = 51200;
const cases = [
  { name: "byte limit and rolling tail", value: "HEAD-ONLY\n" + "0123456789abcdef\n".repeat(20000) + "TAIL-MARKER\n" },
  { name: "line limit", value: "head\n" + "x\n".repeat(2200) + "TAIL-MARKER\n" },
  { name: "one oversized line", value: "HEAD-ONLY" + "x".repeat(bytes * 4) + "TAIL-MARKER" },
  { name: "UTF-8", value: "HEAD-ONLY\n" + "é😀\n".repeat(30000) + "TAIL-MARKER\n" },
];

{
  for (const [name, api] of [["SDK", sdk], ["bundled CLI", bundle]]) {
    test(`${name}: oversized shell output stays in memory`, async () => {
      for (const fixture of cases) {
        const ops = api.createLocalBashOperations();
        // Generate output in the child so the test cannot hit ARG_MAX.
        const expressions = {
          "byte limit and rolling tail": '"HEAD-ONLY\\n" + "0123456789abcdef\\n".repeat(20000) + "TAIL-MARKER\\n"',
          "line limit": '"head\\n" + "x\\n".repeat(2200) + "TAIL-MARKER\\n"',
          "one oversized line": '"HEAD-ONLY" + "x".repeat(204800) + "TAIL-MARKER"',
          "UTF-8": '"HEAD-ONLY\\n" + "é😀\\n".repeat(30000) + "TAIL-MARKER\\n"',
        };
        const localCommand = `${JSON.stringify(process.execPath)} -e 'process.stdout.write(${expressions[fixture.name]})'`;
        const updates = [];
        const tool = api.createBashToolDefinition(directory);
        assert.doesNotMatch(tool.description, /saved to a temp file/);
        const result = await tool.execute("memory-proof", { command: localCommand, timeout: 5 }, undefined, update => updates.push(update));
        assert.equal(result.details.truncation.truncated, true, fixture.name);
        assert.ok(!("fullOutputPath" in result.details));
        const text = result.content[0].text;
        assert.ok(text.includes("TAIL-MARKER"), fixture.name);
        assert.ok(!text.includes("HEAD-ONLY"), fixture.name);
        assert.match(text, /\[Showing (?:lines|last).*Output truncated\]/s);
        assert.doesNotMatch(text, /Full output:|undefined/);
        assert.equal(text.slice(0, text.lastIndexOf("\n\n[")), truncateTail(fixture.value).content);
        for (const expanded of [false, true]) {
          const rendered = tool.renderResult(result, { expanded, isPartial: false }, undefined, { state: {}, showImages: false, invalidate() {} }).render(100).join("\n");
          assert.match(rendered, /Truncated:/);
          assert.doesNotMatch(rendered, /Full output:|undefined/);
        }
        for (const update of updates) assert.ok(!update.details || !("fullOutputPath" in update.details));
        const executed = await api.executeBashWithOperations(localCommand, directory, ops);
        assert.equal(executed.truncated, true, fixture.name);
        assert.equal(executed.output, truncateTail(fixture.value).content);
        assert.ok(!("fullOutputPath" in executed));
        const message = api.bashExecutionToText({ command: localCommand, ...executed });
        assert.match(message, /\[Output truncated\]/);
        assert.doesNotMatch(message, /Full output:|undefined/);
        const component = new api.BashExecutionComponent(localCommand, { requestRender() {} });
        component.appendOutput(executed.output);
        component.setComplete(0, false, { truncated: true });
        assert.match(component.render(100).join("\n"), /Output truncated/);
        assert.deepEqual(spillFiles(), startFiles, fixture.name);
      }
    });
    test(`${name}: cancellation and nonzero exit never spill`, async () => {
      const controller = new AbortController();
      const operations = { exec: async (command, cwd, { onData }) => {
        onData(Buffer.from(cases[0].value));
        controller.abort();
        throw new Error("aborted");
      } };
      const result = await api.executeBashWithOperations("cancel", directory, operations, { signal: controller.signal });
      assert.equal(result.cancelled, true);
      assert.equal(result.truncated, true);
      assert.ok(!("fullOutputPath" in result));
      const tool = api.createBashToolDefinition(directory, { operations: { exec: async (command, cwd, { onData }) => {
        onData(Buffer.from(cases[0].value));
        return { exitCode: 9 };
      } } });
      await assert.rejects(tool.execute("failure", { command: "fail", timeout: 5 }), error => {
        assert.match(error.message, /Output truncated/);
        assert.match(error.message, /Command exited with code 9/);
        assert.doesNotMatch(error.message, /Full output:|undefined/);
        return true;
      });
      assert.deepEqual(spillFiles(), startFiles);
    });
  }
  for (const [name, api] of [["SDK harness", harnessSdk], ["bundled CLI harness", bundle]]) {
    test(`${name}: native environment shell capture never requests a spill`, async () => {
      const env = new NodeExecutionEnv({ cwd: directory });
      let tempFiles = 0;
      env.createTempFile = async () => { tempFiles++; throw new Error("Shell attempted disk persistence"); };
      const nativeExec = env.exec.bind(env);
      env.exec = (command, options, context) => {
        assert.equal(options.capture.spill, false);
        return nativeExec(command, options, context);
      };
      const command = `${JSON.stringify(process.execPath)} -e 'process.stdout.write("head\\n" + "x".repeat(204800) + "TAIL-MARKER")'`;
      const context = { abortSignal: new AbortController().signal };
      const updates = [];
      const result = await api.createHarnessBashTool().execute("native", { command, timeout: 5 }, update => updates.push(update), { env }, undefined, context);
      assert.equal(result.details.truncation.truncated, true);
      assert.ok(!("fullOutputPath" in result.details));
      assert.match(result.content[0].text, /TAIL-MARKER.*Output truncated/s);
      assert.doesNotMatch(result.content[0].text, /Full output:|undefined/);
      for (const update of updates) assert.ok(!update.details || !("fullOutputPath" in update.details));
      const captured = await api.executeShellWithCapture(env, command, { timeout: 5 }, context);
      assert.equal(captured.ok, true);
      assert.equal(captured.value.truncated, true);
      assert.ok(!("fullOutputPath" in captured.value));
      assert.ok(captured.value.output.endsWith("TAIL-MARKER"));
      assert.equal(tempFiles, 0);
      assert.deepEqual(spillFiles(), startFiles);
    });
  }
  test("both installed source forms have valid syntax and no spill implementation", () => {
    for (const path of [join(base, "core/bash-executor.js"), join(base, "core/tools/output-accumulator.js"), bundlePath]) {
      const source = readFileSync(path, "utf8");
      assert.doesNotMatch(source, /pi-bash-\$\{|defaultTempFilePath|ensureTempFile|closeTempFile|snapshot\.fullOutputPath/);
      const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
    }
  });
  test("changed upstream anchors fail before any package file is written", { skip: installedProof }, () => {
    const executorPath = join(base, "core/bash-executor.js");
    const patched = readFileSync(executorPath, "utf8");
    const changed = readFileSync(join(originalBase, "core/bash-executor.js"), "utf8")
      .replace("    const decoder = new TextDecoder();", "    const changedDecoder = new TextDecoder();");
    writeFileSync(executorPath, changed);
    try {
      const bundleBefore = readFileSync(bundlePath, "utf8");
      assert.throws(() => patchBashSpillCopies(modules), /Pinned Pi shell output section changed/);
      assert.equal(readFileSync(executorPath, "utf8"), changed);
      assert.equal(readFileSync(bundlePath, "utf8"), bundleBefore);
    } finally { writeFileSync(executorPath, patched); }
  });
}
