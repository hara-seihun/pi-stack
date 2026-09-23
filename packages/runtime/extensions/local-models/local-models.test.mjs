import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { parseManifest, providerConfig, DEFAULT_THINKING_LEVELS } from "./manifest.mjs";
import { ensureEngine, reachable, applyAdvertised } from "./engine.mjs";
import { mergeCatalog, syncCatalog } from "./catalog.mjs";
import { acquireReservation, leaseCommand } from "./reservation.mjs";
import localModels from "./index.mjs";

const here = new URL(".", import.meta.url).pathname;

async function freePort() {
  return new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

/** Stand in for the benchmark: hold the engine's lock exclusively, exactly as `flock -x` in a shell does. */
function holdExclusive(lock) {
  return new Promise((resolve, reject) => {
    const child = spawn("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", lock, "sh", "-c", "printf held\\n; exec cat"], { stdio: ["pipe", "pipe", "ignore"] });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`maintenance holder could not take ${lock} (exit ${code})`)));
    child.stdout.once("data", () => resolve(() => new Promise((done) => { child.removeAllListeners("exit"); child.on("exit", () => done()); child.stdin.end(); })));
  });
}

/** Try to take the lock exclusively the way `tools/run-batch-compare` does, and report what happened. */
function tryExclusive(lock, waitSeconds) {
  return new Promise((resolve, reject) => {
    const child = spawn("flock", ["--exclusive", "--timeout", String(waitSeconds), "--conflict-exit-code", "75", lock, "true"], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
}

function reservedEngine(port, lock, reservation = {}) {
  return parseManifest(JSON.stringify({ version: 1, engines: [{ id: "fake", name: "Fake", baseUrl: `http://127.0.0.1:${port}/v1`,
    reservation: { lock, ...reservation },
    models: [{ id: "fake-model", icon: "🧪" }],
    start: { command: [process.execPath, join(here, "fake-engine.mjs"), String(port), "0"], readySeconds: 10 } }] })).engines[0];
}

test("manifest parsing fills defaults and rejects malformed entries", () => {
  const manifest = parseManifest(JSON.stringify({ version: 1, engines: [{ id: "halo", baseUrl: "http://127.0.0.1:8471/v1/", models: [{ id: "bonsai-2-27b", reasoning: true, icon: "🌳" }], start: { command: ["halo", "serve"] } }] }));
  const [engine] = manifest.engines;
  assert.equal(engine.baseUrl, "http://127.0.0.1:8471/v1");
  assert.equal(engine.start.unit, "local-model-halo");
  assert.equal(engine.start.readySeconds, 120);
  assert.deepEqual(engine.models[0].thinkingLevelMap, DEFAULT_THINKING_LEVELS);
  assert.deepEqual(engine.models[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(engine.compat.supportsDeveloperRole, false);
  const provider = providerConfig(engine);
  assert.equal(provider.api, "openai-completions");
  assert.equal(provider.apiKey, "local");
  assert.throws(() => parseManifest(JSON.stringify({ version: 2, engines: [] })), /version/);
  assert.throws(() => parseManifest(JSON.stringify({ version: 1, engines: [{ id: "Bad", baseUrl: "http://x", models: [{ id: "m" }] }] })), /lowercase/);
  assert.throws(() => parseManifest(JSON.stringify({ version: 1, engines: [{ id: "a", baseUrl: "http://x", models: [] }] })), /at least one model/);
  assert.throws(() => parseManifest(JSON.stringify({ version: 1, engines: [{ id: "a", baseUrl: "http://x", models: [{ id: "m" }] }] })), /icon is required/);
  assert.throws(() => parseManifest(JSON.stringify({ version: 1, engines: [{ id: "a", baseUrl: "http://x", models: [{ id: "m", icon: "🌳" }], start: { command: [] } }] })), /start.command/);
});

test("an advertised context window fills a model that did not declare one", () => {
  const engine = parseManifest(JSON.stringify({ version: 1, engines: [{ id: "e", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "a", icon: "🌳" }, { id: "b", contextWindow: 4096, icon: "🌲" }] }] })).engines[0];
  const applied = applyAdvertised(engine, [{ id: "a", context_window: 32768 }, { id: "b", context_window: 32768 }]);
  assert.equal(applied.models[0].contextWindow, 32768);
  assert.equal(applied.models[1].contextWindow, 4096);
  assert.equal("contextWindowExplicit" in providerConfig(applied).models[0], false);
});

test("catalog merge replaces engine providers and keeps the rest", () => {
  const current = { providers: { anthropic: { models: [{ id: "x" }] }, old: { baseUrl: "http://old" } } };
  const engine = parseManifest(JSON.stringify({ version: 1, engines: [{ id: "halo", name: "Halo", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "m", icon: "🌳" }] }] })).engines[0];
  const merged = mergeCatalog(current, [engine], ["old"]);
  assert.deepEqual(Object.keys(merged.providers).sort(), ["anthropic", "halo"]);
  assert.equal(merged.providers.halo.name, "Halo");
});

test("an unreachable engine with a start command is launched and awaited", async () => {
  const port = await freePort();
  const engine = parseManifest(JSON.stringify({ version: 1, engines: [{ id: "fake", baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: "fake", icon: "🧪" }], start: { command: [process.execPath, join(here, "fake-engine.mjs"), String(port), "400"], readySeconds: 10 } }] })).engines[0];
  assert.equal(await reachable(engine.baseUrl), false);
  const state = await ensureEngine(engine, { environment: { ...process.env, PI_STACK_LOCAL_MODELS_LAUNCHER: "direct" }, pollMs: 100 });
  assert.equal(state.ready, true);
  assert.equal(state.launched, true);
  assert.equal(await reachable(engine.baseUrl), true);
  const again = await ensureEngine(engine, { environment: { ...process.env, PI_STACK_LOCAL_MODELS_LAUNCHER: "direct" } });
  assert.deepEqual(again, { ready: true, launched: false, detail: "already running" });
});

test("a maintenance holder stops the engine being started, and keeps its models in the catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "local-models-reserved-"));
  try {
    const lock = join(dir, "engine.lock");
    const port = await freePort();
    const engine = reservedEngine(port, lock);
    assert.deepEqual(leaseCommand(engine.reservation, 0).at(1).slice(0, 4), ["--shared", "--nonblock", "--conflict-exit-code", "75"]);
    const releaseMaintenance = await holdExclusive(lock);
    try {
      const state = await ensureEngine(engine, { environment: { ...process.env, PI_STACK_LOCAL_MODELS_LAUNCHER: "direct" }, pollMs: 50 });
      assert.deepEqual(state, { ready: false, launched: false, reserved: true, detail: `reserved for maintenance: another holder has ${lock}` });
      assert.equal(await reachable(engine.baseUrl), false, "the reserved engine was not started");

      await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: "http://stale" }, keep: { baseUrl: "http://keep" } } }));
      await writeFile(join(dir, "local-models.json"), JSON.stringify({ version: 1, engines: [{ id: "fake", name: "Fake", baseUrl: engine.baseUrl,
        reservation: { lock }, models: [{ id: "fake-model", icon: "🧪" }],
        start: { command: [process.execPath, join(here, "fake-engine.mjs"), String(port), "0"], readySeconds: 10 } }] }));
      const registered = [];
      const previous = { ...process.env };
      Object.assign(process.env, { PI_CODING_AGENT_DIR: dir, PI_STACK_LOCAL_MODELS_LAUNCHER: "direct", PI_STACK_LOCAL_MODELS_QUIET: "1" });
      try { await localModels({ registerProvider: (id, config) => registered.push([id, config]) }); }
      finally { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); }
      assert.equal(await reachable(engine.baseUrl), false, "the extension did not start the reserved engine either");
      assert.deepEqual(registered.map(([id]) => id), ["fake"], "a paused engine stays selectable");
      const catalog = JSON.parse(await readFile(join(dir, "models.json"), "utf8"));
      assert.deepEqual(Object.keys(catalog.providers).sort(), ["fake", "keep"]);
      assert.equal(catalog.providers.fake.baseUrl, engine.baseUrl, "maintenance does not drop the engine from the catalog");
    } finally { await releaseMaintenance(); }

    const state = await ensureEngine(engine, { environment: { ...process.env, PI_STACK_LOCAL_MODELS_LAUNCHER: "direct" }, pollMs: 50 });
    assert.equal(state.ready, true, "the engine starts again once the lease ends");
    assert.equal(state.launched, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a start in progress holds the reservation, so maintenance waits instead of racing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "local-models-race-"));
  try {
    const lock = join(dir, "engine.lock");
    const port = await freePort();
    const engine = parseManifest(JSON.stringify({ version: 1, engines: [{ id: "fake", baseUrl: `http://127.0.0.1:${port}/v1`,
      reservation: { lock }, models: [{ id: "fake-model", icon: "🧪" }],
      start: { command: [process.execPath, join(here, "fake-engine.mjs"), String(port), "700"], readySeconds: 10 } }] })).engines[0];
    const starting = ensureEngine(engine, { environment: { ...process.env, PI_STACK_LOCAL_MODELS_LAUNCHER: "direct" }, pollMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(await tryExclusive(lock, 0.2), 75, "maintenance cannot stop an engine that is coming up");
    assert.equal((await starting).ready, true);
    assert.equal(await tryExclusive(lock, 1), 0, "the lease is released as soon as the engine is up");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a bounded wait joins the engine after the lease ends, and an unusable lock refuses the start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "local-models-wait-"));
  try {
    const lock = join(dir, "engine.lock");
    const port = await freePort();
    const engine = reservedEngine(port, lock, { waitSeconds: 5 });
    assert.equal(engine.reservation.waitSeconds, 5);
    const releaseMaintenance = await holdExclusive(lock);
    setTimeout(() => void releaseMaintenance(), 300);
    const state = await ensureEngine(engine, { environment: { ...process.env, PI_STACK_LOCAL_MODELS_LAUNCHER: "direct" }, pollMs: 50 });
    assert.equal(state.ready, true, "a foreground consumer may wait a bounded time for the engine");

    const unusable = await acquireReservation({ lock, waitSeconds: 0 }, { spawnImpl: () => { throw new Error("flock is missing"); } });
    assert.deepEqual(unusable, { ok: false, reserved: false, detail: `cannot run flock for ${lock}: flock is missing` });
    const refused = await ensureEngine({ ...engine, reservation: { lock, waitSeconds: 0 } }, { spawnImpl: () => { throw new Error("flock is missing"); } });
    assert.equal(refused.ready, false, "a reservation that cannot be evaluated is never ignored");
    assert.equal(refused.reserved, false);
    assert.match(refused.detail, /reservation unavailable/);

    assert.throws(() => parseManifest(JSON.stringify({ version: 1, engines: [{ id: "a", baseUrl: "http://x", reservation: { lock: "relative" }, models: [{ id: "m", icon: "🌳" }] }] })), /reservation.lock must be an absolute path/);
    assert.throws(() => parseManifest(JSON.stringify({ version: 1, engines: [{ id: "a", baseUrl: "http://x", reservation: { lock: "/tmp/l", waitSeconds: -1 }, models: [{ id: "m", icon: "🌳" }] }] })), /waitSeconds/);
    assert.equal(parseManifest(JSON.stringify({ version: 1, engines: [{ id: "a", baseUrl: "http://x", models: [{ id: "m", icon: "🌳" }] }] })).engines[0].reservation, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an unreachable engine without a start command is reported, not registered", async () => {
  const port = await freePort();
  const engine = parseManifest(JSON.stringify({ version: 1, engines: [{ id: "down", baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: "m", icon: "🌳" }] }] })).engines[0];
  const state = await ensureEngine(engine, {});
  assert.equal(state.ready, false);
  assert.match(state.detail, /no start command/);
});

test("the extension registers reachable engines and writes the catalog", async () => {
  const dir = await mkdtemp(join(tmpdir(), "local-models-"));
  try {
    const port = await freePort();
    const downPort = await freePort();
    await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { keep: { baseUrl: "http://keep" }, down: { baseUrl: "http://stale" } } }));
    await writeFile(join(dir, "local-models.json"), JSON.stringify({ version: 1, engines: [
      { id: "fake", name: "Fake", baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: "fake-model", reasoning: true, icon: "🧪" }], start: { command: [process.execPath, join(here, "fake-engine.mjs"), String(port), "0"], readySeconds: 10 } },
      { id: "down", baseUrl: `http://127.0.0.1:${downPort}/v1`, models: [{ id: "m", icon: "🌳" }] },
    ] }));
    const registered = [];
    const previous = { ...process.env };
    Object.assign(process.env, { PI_CODING_AGENT_DIR: dir, PI_STACK_LOCAL_MODELS_LAUNCHER: "direct", PI_STACK_LOCAL_MODELS_QUIET: "1" });
    try { await localModels({ registerProvider: (id, config) => registered.push([id, config]) }); }
    finally { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); }
    assert.deepEqual(registered.map(([id]) => id), ["fake"]);
    assert.equal(registered[0][1].models[0].thinkingLevelMap.high, "xhigh");
    assert.equal(registered[0][1].models[0].contextWindow, 32768, "the engine's advertised context fills the unset manifest value");
    const catalog = JSON.parse(await readFile(join(dir, "models.json"), "utf8"));
    assert.deepEqual(Object.keys(catalog.providers).sort(), ["fake", "keep"]);
    assert.equal(catalog.providers.fake.baseUrl, `http://127.0.0.1:${port}/v1`);
    const same = applyAdvertised(parseManifest(JSON.stringify({ version: 1, engines: [{ id: "fake", name: "Fake", baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: "fake-model", reasoning: true, icon: "🧪" }] }] })).engines[0], [{ id: "fake-model", context_window: 32768 }]);
    assert.equal(await syncCatalog([same], { environment: { PI_CODING_AGENT_DIR: dir } }), false, "a second sync with the same content does not rewrite");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
