import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

export async function probeFileTools(nodeModules) {
  const base = join(nodeModules, "@earendil-works/pi-coding-agent/dist");
  const tools = await import(pathToFileURL(join(base, "core/tools/index.js")).href);
  assert.equal(tools.allToolNames.has("append"), true);
  const root = await mkdtemp(join(tmpdir(), "pi-write-probe-"));
  try {
    const write = tools.createWriteToolDefinition(root);
    const append = tools.createAppendToolDefinition(root);
    assert(write.parameters.properties.overwrite);
    assert(tools.createCodingTools(root).some(tool => tool.name === "append"));
    const path = join(root, "synthetic.txt");
    const original = Buffer.from("é".repeat(9000));
    await writeFile(path, original);
    for (const content of ["", " \n\t", "short rewrite", "x".repeat(9000)]) {
      await assert.rejects(write.execute("refuse", { path, content }), { code: "WRITE_DESTRUCTIVE_OVERWRITE_REFUSED" });
      assert.deepEqual(await readFile(path), original);
    }
    await assert.rejects(write.execute("stale", { path, content: "", overwrite: { expectedBytes: 17, reason: "synthetic deliberate truncation" } }), { code: "WRITE_OVERRIDE_CONFLICT" });
    assert.deepEqual(await readFile(path), original);
    await write.execute("deliberate", { path, content: "", overwrite: { expectedBytes: original.length, reason: "synthetic deliberate truncation" } });
    assert.equal((await readFile(path)).length, 0);
    await write.execute("new", { path: "parents/new.txt", content: "" });
    await write.execute("rewrite", { path, content: "abc" });
    await write.execute("ordinary", { path, content: "xy" });
    assert.equal(await readFile(path, "utf8"), "xy");
    await append.execute("append", { path, content: "first\n" });
    assert.equal(await readFile(path, "utf8"), "xyfirst\n");
    const entries = Array.from({ length: 20 }, (_, index) => `<entry-${index}>`);
    await Promise.all(entries.map((content, index) => append.execute(`parallel-${index}`, { path, content })));
    assert.equal(await readFile(path, "utf8"), "xyfirst\n" + entries.join(""));
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(write.execute("cancel", { path, content: "same" }, aborted.signal), /aborted/);
    await assert.rejects(append.execute("cancel-append", { path, content: "lost" }, aborted.signal), /aborted/);
    assert.equal(await readFile(path, "utf8"), "xyfirst\n" + entries.join(""));
    const chunks = join(base, "bundle/chunks");
    const candidates = [];
    for (const name of await readdir(chunks)) if (name.endsWith(".js") && (await readFile(join(chunks, name), "utf8")).includes('function createWriteToolDefinition(cwd,options)')) candidates.push(name);
    assert.equal(candidates.length, 1);
    const cli = await import(pathToFileURL(join(chunks, candidates[0])).href);
    const cliWrite = cli.createWriteToolDefinition(root);
    const cliAppend = cli.createCodingTools(root).find(tool => tool.name === "append");
    assert(cliAppend);
    const core = join(nodeModules, "@earendil-works/pi-agent-core/dist");
    const harness = await import(pathToFileURL(join(core, "harness/tools/index.js")).href);
    const { NodeExecutionEnv } = await import(pathToFileURL(join(core, "harness/env/nodejs.js")).href);
    const env = new NodeExecutionEnv({ cwd: root });
    const context = { abortSignal: new AbortController().signal };
    const harnessWrite = harness.createWriteTool(), harnessAppend = harness.createAppendTool();
    const consumers = [
      { name: "cli", write: input => cliWrite.execute("cli-probe", input), append: input => cliAppend.execute("cli-append-probe", input) },
      { name: "harness", write: input => harnessWrite.execute("harness-probe", input, undefined, { env }, undefined, context), append: input => harnessAppend.execute("harness-append-probe", input, undefined, { env }, undefined, context) },
    ];
    for (const consumer of consumers) {
      const destination = join(root, `${consumer.name}.txt`);
      await writeFile(destination, original);
      for (const content of ["", "short rewrite"]) {
        await assert.rejects(consumer.write({ path: destination, content }), { code: "WRITE_DESTRUCTIVE_OVERWRITE_REFUSED" });
        assert.deepEqual(await readFile(destination), original);
      }
      await consumer.append({ path: destination, content: "tail" });
      assert.deepEqual(await readFile(destination), Buffer.concat([original, Buffer.from("tail")]));
      await consumer.write({ path: destination, content: "", overwrite: { expectedBytes: original.length + 4, reason: "synthetic deliberate truncation" } });
      assert.equal((await readFile(destination)).length, 0);
    }
    return { protocol: "file-write-probe-v1", sdk: base, consumers: ["sdk", "cli", "harness"], passed: true, cases: ["blank", "whitespace", "substantial-shrink", "half-boundary", "override-conflict", "deliberate-overwrite", "new-file", "ordinary-rewrite", "no-newline-append", "concurrent-append", "pre-abort"] };
  } finally { await rm(root, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node file-write-probe.mjs NODE_MODULES");
  console.log(JSON.stringify(await probeFileTools(resolve(process.argv[2]))));
}
