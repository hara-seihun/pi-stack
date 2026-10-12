import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUILT_IN_BACKENDS, loadBackend, loadManifest, manifestPath, parseManifest } from "./manifest.mjs";
import parallel, { parallelRequest, parallelResults, resolveCommand, runTransport } from "./backends/parallel.mjs";
import { formatResults, searchParameters } from "./tool.mjs";
import webSearch from "./index.mjs";

const workspace = () => mkdtemp(join(tmpdir(), "web-search-test-"));
const quiet = { PI_STACK_WEB_SEARCH_QUIET: "1" };

/** A stand-in Parallel transport: no credential access or network calls. */
async function fakeTransport(directory, { body, status = 0, stderr = "" } = {}) {
  const path = join(directory, "parallel-search");
  const script = [
    `#!${process.execPath}`,
    "import { readFileSync, writeFileSync } from \"node:fs\";",
    `writeFileSync(${JSON.stringify(join(directory, "request.json"))}, readFileSync(0));`,
    `writeFileSync(${JSON.stringify(join(directory, "endpoint"))}, process.argv[2] ?? "");`,
    stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : "",
    body === undefined ? "" : `process.stdout.write(${JSON.stringify(body)});`,
    `process.exitCode = ${status};`,
  ].filter(Boolean).join("\n");
  await writeFile(path, `${script}\n`);
  await chmod(path, 0o755);
  return path;
}

const sampleResponse = JSON.stringify({ requestId: "search-original", results: [
  { title: "Ubuntu manual", url: "https://ubuntu.com/manual", publishedDate: "2026-02-03", snippet: "Original excerpt" },
  { title: "Page", url: "https://example.com/page", snippet: "Page excerpt", text: "Full page text" },
], notes: ["Parallel category is a source preference"], usage: { search: { requests: 1 } } });

test("a missing manifest cannot silently select a provider", async () => {
  const directory = await workspace();
  await assert.rejects(loadManifest({ ...quiet, PI_STACK_WEB_SEARCH: join(directory, "absent.json") }), /no manifest configured/);
});

test("the manifest path follows the Pi agent directory", () => {
  assert.equal(manifestPath({ PI_CODING_AGENT_DIR: "/tmp/agent" }), "/tmp/agent/web-search.json");
  assert.equal(manifestPath({ PI_STACK_WEB_SEARCH: "/tmp/other.json", PI_CODING_AGENT_DIR: "/tmp/agent" }), "/tmp/other.json");
});

test("the manifest selects, configures and disables backends", () => {
  assert.equal(parseManifest('{"version":1,"backend":"none"}').backend, null);
  assert.equal(parseManifest('{"version":1,"backend":null}').backend, null);
  const builtIn = parseManifest('{"version":1,"backend":"parallel","defaultResults":3}');
  assert.equal(builtIn.defaultResults, 3); assert.equal(builtIn.backend.module, BUILT_IN_BACKENDS.parallel);
  assert.throws(() => parseManifest('{"version":1}'), /backend is required/);
  assert.throws(() => parseManifest('{"version":1,"backend":"exa"}'), /unknown backend exa/);
  assert.throws(() => parseManifest('{"version":1,"backend":{"id":"exa","module":"/synthetic/exa.mjs"}}'), /unknown backend exa/);
  const custom = parseManifest('{"version":1,"backend":{"id":"house","module":"/opt/house/search.mjs","options":{"endpoint":"http://localhost:9000"}}}');
  assert.equal(custom.backend.id, "house");
  assert.equal(custom.backend.module, "file:///opt/house/search.mjs");
  assert.deepEqual(custom.backend.options, { endpoint: "http://localhost:9000" });
  assert.throws(() => parseManifest('{"version":2}'), /version must be 1/);
  assert.throws(() => parseManifest('{"version":1,"backend":"bing"}'), /unknown backend bing/);
  assert.throws(() => parseManifest('{"version":1,"backend":{"id":"house"}}'), /not built in/);
  assert.throws(() => parseManifest('{"version":1,"backend":{"id":"house","module":"relative.mjs"}}'), /absolute path/);
  assert.throws(() => parseManifest('{"version":1,"defaultResults":99}'), /defaultResults/);
});

test("an explicit authorized host backend remains supported",  async () => {
  const directory = await workspace();
  const module = join(directory, "backend.mjs");
  await writeFile(module, `export default ({ options }) => ({
    id: "house", label: "House index", summary: "internal",
    async status() { return { available: true }; },
    async search(request) { return { results: [{ title: "internal", url: options.endpoint + "/" + request.query, snippet: "hit" }] }; },
  });\n`);
  const manifest = parseManifest(JSON.stringify({ version: 1, backend: { id: "house", module, options: { endpoint: "http://localhost:9000" } } }));
  const backend = await loadBackend(manifest.backend, { environment: quiet });
  assert.equal(backend.label, "House index");
  assert.equal((await backend.status({})).available, true);
  const { results } = await backend.search({ query: "q" }, { options: backend.options });
  assert.equal(results[0].url, "http://localhost:9000/q");
});

test("a backend without search is rejected", async () => {
  const directory = await workspace();
  const module = join(directory, "broken.mjs");
  await writeFile(module, "export default { id: \"broken\" };\n");
  await assert.rejects(loadBackend({ id: "broken", module: `file://${module}`, options: {} }), /no search/);
});

test("Parallel request preserves the native query/filter/extraction contract", () => {
  assert.deepEqual(parallelRequest({ query: "q", numResults: 5 }), { query: "q", numResults: 5, text: false });
  const full = { query: "q", numResults: 2, text: true, category: "news", includeDomains: ["bbc.com"], excludeDomains: ["x.com"], startPublishedDate: "2026-01-01" };
  assert.deepEqual(parallelRequest(full), full);
  assert.equal("includeDomains" in parallelRequest({ query: "q", numResults: 1, includeDomains: [] }), false);
});

test("Parallel results retain excerpts/page text and reject malformed success", () => {
  const [first, second] = parallelResults(JSON.parse(sampleResponse));
  assert.equal(first.snippet, "Original excerpt"); assert.equal(first.publishedDate, "2026-02-03"); assert.equal(second.text, "Full page text");
  for (const malformed of [{}, { results: [null] }, { results: [{ title: "x", url: "file:///private", snippet: "x" }] }, { results: [], notes: [{}] }]) assert.throws(() => parallelResults(malformed));
});

test("the Parallel backend is unavailable without its account transport", async () => {
  const directory = await workspace();
  assert.equal(resolveCommand("parallel-search", { PATH: directory }), undefined);
  const status = await parallel.status({ environment: { PATH: directory } });
  assert.equal(status.available, false); assert.match(status.reason, /not executable on PATH/);
  await assert.rejects(parallel.search({ query: "q", numResults: 1 }, { environment: { PATH: directory } }), /not configured/);
});

test("Parallel backend dispatches exactly one native request and retains receipt identity/usage", async () => {
  const directory = await workspace(); await fakeTransport(directory, { body: sampleResponse });
  const environment = { ...process.env, PATH: directory };
  const request = { query: "ubuntu", numResults: 2, text: true, includeDomains: ["ubuntu.com"], excludeDomains: ["blocked.test"], startPublishedDate: "2026-01-01", category: "news" };
  const response = await parallel.search(request, { environment });
  assert.equal(response.results.length, 2); assert.equal(response.requestId, "search-original"); assert.deepEqual(response.usage, { search: { requests: 1 } });
  assert.deepEqual(JSON.parse(await readFile(join(directory, "request.json"), "utf8")), request);
  assert.equal(await readFile(join(directory, "endpoint"), "utf8"), "");
});

test("refused or malformed Parallel transport never falls back or returns empty success", async () => {
  const directory = await workspace();
  await writeFile(join(directory, "exa-api"), `#!${process.execPath}\nthrow new Error('Forbidden Exa fallback');\n`); await chmod(join(directory, "exa-api"), 0o755);
  const environment = { ...process.env, PATH: directory };
  await fakeTransport(directory, { status: 65, stderr: "Parallel search HTTP 402: prepaid credit exhausted" });
  await assert.rejects(parallel.search({ query: "q", numResults: 1 }, { environment }), /HTTP 402: prepaid credit exhausted/);
  await fakeTransport(directory, { body: "not JSON" }); await assert.rejects(parallel.search({ query: "q", numResults: 1 }, { environment }), /non-JSON/);
  await fakeTransport(directory, { body: "{}" }); await assert.rejects(parallel.search({ query: "q", numResults: 1 }, { environment }), /invalid search receipt/);
});

test("results render as a readable list", () => {
  const text = formatResults("ubuntu", parallelResults(JSON.parse(sampleResponse)), ["cost $0.005"]);
  assert.match(text, /2 results for "ubuntu"/);
  assert.match(text, /1\. Ubuntu manual\n {3}https:\/\/ubuntu\.com\/manual\n {3}2026-02-03/);
  assert.match(text, /cost \$0\.005$/);
  assert.match(formatResults("nothing", []), /No the web results/);
});

test("parameters accept a query and bound the result count", () => {
  const schema = searchParameters(6);
  assert.deepEqual(schema.required, ["query"]);
  assert.equal(schema.properties.numResults.maximum, 25);
  assert.match(schema.properties.numResults.description, /Defaults to 6/);
});

test("the extension registers web_search with a prompt snippet and runs a search", async () => {
  const directory = await workspace();
  await fakeTransport(directory, { body: sampleResponse });
  const previous = { PATH: process.env.PATH, PI_STACK_WEB_SEARCH: process.env.PI_STACK_WEB_SEARCH, PI_STACK_WEB_SEARCH_QUIET: process.env.PI_STACK_WEB_SEARCH_QUIET };
  process.env.PATH = directory;
  process.env.PI_STACK_WEB_SEARCH = join(directory, "web-search.json");
  await writeFile(process.env.PI_STACK_WEB_SEARCH, JSON.stringify({ version: 1, backend: "parallel" }));
  process.env.PI_STACK_WEB_SEARCH_QUIET = "1";
  try {
    const tools = [];
    await webSearch({ registerTool: (tool) => tools.push(tool) });
    assert.equal(tools.length, 1);
    const [tool] = tools;
    assert.equal(tool.name, "web_search");
    assert.match(tool.promptSnippet, /host's current search provider/);
    assert.match(tool.description, /Reach for this first/);
    const updates = [];
    const result = await tool.execute("call-1", { query: "ubuntu" }, undefined, (update) => updates.push(update));
    assert.match(result.content[0].text, /Ubuntu manual/);
    assert.equal(result.details.backend, "parallel");
    assert.equal(result.details.results.length, 2);
    assert.equal(updates.length, 1);
    await assert.rejects(tool.execute("call-2", { query: "   " }), /cannot be blank/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a long-lived tool adopts provider, options, defaults and source changes without reloading", async () => {
  const directory = await workspace();
  const manifestPath = join(directory, "web-search.json");
  const module = join(directory, "host.mjs");
  const writeBackend = (label) => writeFile(module, `export default ({ options }) => ({
    id: options.id, label: ${JSON.stringify(label)},
    async search(request) { return { results: [{ title: options.id + ':' + request.numResults, url: 'https://example.com', snippet: options.note }] }; }
  });`);
  const writeManifest = (id, defaultResults) => writeFile(manifestPath, JSON.stringify({ version: 1, backend: { id, module, options: { id, note: id } }, defaultResults }));
  const previous = { PI_STACK_WEB_SEARCH: process.env.PI_STACK_WEB_SEARCH, PI_STACK_WEB_SEARCH_QUIET: process.env.PI_STACK_WEB_SEARCH_QUIET };
  process.env.PI_STACK_WEB_SEARCH = manifestPath;
  process.env.PI_STACK_WEB_SEARCH_QUIET = "1";
  try {
    await writeBackend("First"); await writeManifest("first", 2);
    let tool; await webSearch({ registerTool: (registered) => { tool = registered; } });
    assert.equal((await tool.execute("1", { query: "q" })).details.backend, "first");
    await writeManifest("second", 3);
    const second = await tool.execute("2", { query: "q" });
    assert.equal(second.details.backend, "second"); assert.equal(second.details.results[0].title, "second:3");
    await writeBackend("Updated");
    const updates = [];
    await tool.execute("3", { query: "q", numResults: 5 }, undefined, (u) => updates.push(u));
    assert.equal(updates[0].content[0].text, "Searching Updated…");
    await writeFile(manifestPath, JSON.stringify({ version: 1, backend: "none" }));
    await assert.rejects(tool.execute("4", { query: "q" }), /disabled by the host/);
    await writeFile(manifestPath, "bad JSON");
    await assert.rejects(tool.execute("5", { query: "q" }), /JSON/);
    await writeFile(manifestPath, JSON.stringify({ version: 1, backend: "exa" }));
    await assert.rejects(tool.execute("exa-refused", { query: "q" }), /unknown backend exa/);
    await writeManifest("recovered", 4);
    assert.equal((await tool.execute("6", { query: "q" })).details.backend, "recovered");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("the extension registers nothing when the host disables search", async () => {
  const directory = await workspace();
  const path = join(directory, "web-search.json");
  await writeFile(path, JSON.stringify({ version: 1, backend: "none" }));
  process.env.PI_STACK_WEB_SEARCH = path;
  process.env.PI_STACK_WEB_SEARCH_QUIET = "1";
  try {
    const tools = [];
    await webSearch({ registerTool: (tool) => tools.push(tool) });
    assert.equal(tools.length, 0);
  } finally {
    delete process.env.PI_STACK_WEB_SEARCH;
    delete process.env.PI_STACK_WEB_SEARCH_QUIET;
  }
});

test("cancellation reaps the resistant transport before settling the request", { timeout: 3000 }, async () => {
  const directory = await workspace(), path = join(directory, "parallel-search"), controller = new AbortController();
  await writeFile(path, `#!${process.execPath}\nimport { writeFileSync, readFileSync } from 'node:fs';\nreadFileSync(0); process.on('SIGTERM', () => {}); writeFileSync(${JSON.stringify(join(directory, "started"))}, String(process.pid)); setInterval(() => {}, 1000);\n`);
  await chmod(path, 0o755);
  let watcher;
  const entered = new Promise(resolve => { watcher = watch(directory, (_event, filename) => { if (filename === "started") { watcher.close(); resolve(); } }); });
  const pending = runTransport(path, { query: "synthetic" }, { environment: { PATH: directory }, signal: controller.signal });
  const rejected = assert.rejects(pending, /aborted/);
  try {
    await entered; const pid = Number(await readFile(join(directory, "started"), "utf8"));
    controller.abort(); await rejected;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { watcher.close(); controller.abort(); }
});

test("oversized transport output is an explicit bounded failure", async () => {
  const directory = await workspace(), path = join(directory, "parallel-search");
  await writeFile(path, `#!${process.execPath}\nprocess.stdin.resume(); process.stdout.write('x'.repeat(12 * 1024 * 1024 + 1));\n`); await chmod(path, 0o755);
  await assert.rejects(runTransport(path, { query: "synthetic" }, { environment: { PATH: directory } }), /12 MiB receipt bound/);
});
