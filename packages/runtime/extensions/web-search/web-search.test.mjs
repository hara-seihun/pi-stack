import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUILT_IN_BACKENDS, loadBackend, loadManifest, manifestPath, parseManifest } from "./manifest.mjs";
import exa, { exaRequest, exaResults, resolveCommand } from "./backends/exa.mjs";
import { formatResults, searchParameters } from "./tool.mjs";
import webSearch from "./index.mjs";

const workspace = () => mkdtemp(join(tmpdir(), "web-search-test-"));
const quiet = { PI_STACK_WEB_SEARCH_QUIET: "1" };

/** A stand-in `exa-api` that records its request and answers with a fixed response. */
async function fakeTransport(directory, { body, status = 0, stderr = "" } = {}) {
  const path = join(directory, "exa-api");
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

const sampleResponse = JSON.stringify({
  requestId: "req-1",
  resolvedSearchType: "neural",
  results: [
    { title: "NixOS manual", url: "https://nixos.org/manual", publishedDate: "2026-02-03T00:00:00.000Z", author: "NixOS", score: 0.42, highlights: ["Declarative  configuration", "Atomic upgrades"] },
    { title: "", url: "https://example.com/page", text: "Full page text" },
  ],
  costDollars: { total: 0.005 },
});

test("a missing manifest still selects the default backend", async () => {
  const directory = await workspace();
  const manifest = await loadManifest({ ...quiet, PI_STACK_WEB_SEARCH: join(directory, "absent.json") });
  assert.equal(manifest.missing, true);
  assert.equal(manifest.backend.id, "exa");
  assert.equal(manifest.backend.module, BUILT_IN_BACKENDS.exa);
  assert.equal(manifest.defaultResults, 8);
});

test("the manifest path follows the Pi agent directory", () => {
  assert.equal(manifestPath({ PI_CODING_AGENT_DIR: "/tmp/agent" }), "/tmp/agent/web-search.json");
  assert.equal(manifestPath({ PI_STACK_WEB_SEARCH: "/tmp/other.json", PI_CODING_AGENT_DIR: "/tmp/agent" }), "/tmp/other.json");
});

test("the manifest selects, configures and disables backends", () => {
  assert.equal(parseManifest('{"version":1,"backend":"none"}').backend, null);
  assert.equal(parseManifest('{"version":1,"backend":null}').backend, null);
  assert.equal(parseManifest('{"version":1,"defaultResults":3}').defaultResults, 3);
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

test("a host backend module can replace Exa", async () => {
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

test("the Exa request keeps excerpts cheap and honours filters", () => {
  const cheap = exaRequest({ query: "q", numResults: 5 });
  assert.deepEqual(cheap.contents, { highlights: { numSentences: 3, highlightsPerUrl: 2 } });
  assert.equal(cheap.type, "auto");
  const full = exaRequest({ query: "q", numResults: 2, text: true, category: "news", includeDomains: ["bbc.com"], excludeDomains: ["x.com"], startPublishedDate: "2026-01-01" });
  assert.equal(full.contents.text.maxCharacters, 4000);
  assert.equal(full.category, "news");
  assert.deepEqual(full.includeDomains, ["bbc.com"]);
  assert.deepEqual(full.excludeDomains, ["x.com"]);
  assert.equal(full.startPublishedDate, "2026-01-01");
  assert.equal("includeDomains" in exaRequest({ query: "q", numResults: 1, includeDomains: [] }), false);
});

test("Exa results collapse into the backend contract", () => {
  const [first, second] = exaResults(JSON.parse(sampleResponse));
  assert.equal(first.snippet, "Declarative configuration … Atomic upgrades");
  assert.equal(first.publishedDate, "2026-02-03T00:00:00.000Z");
  assert.equal(second.title, "https://example.com/page");
  assert.equal(second.text, "Full page text");
});

test("the Exa backend is unavailable without its transport", async () => {
  const directory = await workspace();
  assert.equal(resolveCommand("exa-api", { PATH: directory }), undefined);
  const status = await exa.status({ environment: { PATH: directory } });
  assert.equal(status.available, false);
  assert.match(status.reason, /not an executable on PATH/);
});

test("the Exa backend sends the request body to the transport", async () => {
  const directory = await workspace();
  await fakeTransport(directory, { body: sampleResponse });
  const environment = { ...process.env, PATH: directory };
  const response = await exa.search({ query: "nixos", numResults: 2 }, { environment });
  assert.equal(response.results.length, 2);
  assert.equal(response.requestId, "req-1");
  assert.deepEqual(response.usage, { costDollars: { total: 0.005 } });
  const sent = JSON.parse(await readFile(join(directory, "request.json"), "utf8"));
  assert.equal(sent.query, "nixos");
  assert.equal(sent.numResults, 2);
  assert.equal(await readFile(join(directory, "endpoint"), "utf8"), "search");
});

test("a refused transport surfaces its message verbatim", async () => {
  const directory = await workspace();
  await fakeTransport(directory, { status: 65, stderr: "exa-api: autonomous Projects Research task research-materials may not call Exa Search" });
  await assert.rejects(
    exa.search({ query: "q", numResults: 1 }, { environment: { ...process.env, PATH: directory } }),
    /may not call Exa Search/,
  );
});

test("results render as a readable list", () => {
  const text = formatResults("nixos", exaResults(JSON.parse(sampleResponse)), ["cost $0.005"]);
  assert.match(text, /2 results for "nixos"/);
  assert.match(text, /1\. NixOS manual\n {3}https:\/\/nixos\.org\/manual\n {3}2026-02-03 · NixOS/);
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
  process.env.PI_STACK_WEB_SEARCH = join(directory, "absent.json");
  process.env.PI_STACK_WEB_SEARCH_QUIET = "1";
  try {
    const tools = [];
    await webSearch({ registerTool: (tool) => tools.push(tool) });
    assert.equal(tools.length, 1);
    const [tool] = tools;
    assert.equal(tool.name, "web_search");
    assert.match(tool.promptSnippet, /^web_search: search the live web through Exa/);
    assert.match(tool.description, /Reach for this first/);
    const updates = [];
    const result = await tool.execute("call-1", { query: "nixos" }, undefined, (update) => updates.push(update));
    assert.match(result.content[0].text, /NixOS manual/);
    assert.equal(result.details.backend, "exa");
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
